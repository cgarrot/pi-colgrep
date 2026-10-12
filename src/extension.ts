import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { isAgentModelInstalled } from "./lib/agent";
import { createAvailabilityState } from "./lib/availability";
import { runIndexBuild } from "./lib/builder";
import {
  DEFAULT_CONFIG,
  getGlobalConfigPath,
  getProjectConfigPath,
  loadConfig,
  type ColGrepConfig,
} from "./lib/config";
import { classifyBashCommand } from "./lib/guard";
import { countFilesUpTo, exceedsCap, tooLargeMessage } from "./lib/index-size";
import { checkIndexExists } from "./lib/index-status";
import { isUnsafeIndexRoot, unsafeRootMessage } from "./lib/paths";
import { createReindexer, type Reindexer } from "./lib/reindex";
import { createSlotLimiter, createSlotRunner } from "./lib/slots";
import {
  formatStatsSummary,
  getStatsPath,
  recordStat,
  summarizeStats,
} from "./lib/stats";
import { registerColGrep } from "./tools/colgrep";
import { registerColGrepAgent } from "./tools/colgrep_agent";

const COLGREP_WIDGET_KEY = "colgrep-index";
const AGENT_INSTALL_TIMEOUT_MS = 30 * 60 * 1000;

interface UiCtxLike {
  cwd: string;
  ui: {
    notify: (message: string, type?: "error" | "warning" | "info") => void;
    setWidget?: (key: string, lines: string[] | undefined) => void;
  };
}

/** Indexing status lives in a widget above the editor, with live progress. */
function setIndexWidget(ctx: UiCtxLike, lines: string[] | undefined): void {
  if (typeof ctx.ui.setWidget === "function") {
    ctx.ui.setWidget(COLGREP_WIDGET_KEY, lines);
  }
}

export default function piColGrepExtension(pi: ExtensionAPI): void {
  const availability = createAvailabilityState();
  let reindexer: Reindexer | undefined;
  // Whether a colgrep index exists for the current session's cwd. Probed once
  // on session_start and flipped true when an index is built. The write/edit
  // auto-reindex is gated on this so we never proactively index a directory
  // the operator never searches.
  let indexExists = false;
  // Limits the "no index, skipping" notice to one per session.
  let skipWarned = false;
  // True when the session cwd must never be indexed (home directory, root).
  let unsafeRoot = false;
  // Session-scoped config (guard + agent settings), read by the tool_call
  // guard and the colgrep_agent tool.
  let sessionConfig: ColGrepConfig | undefined;
  // Tri-state: undefined until probed on session_start, then boolean.
  let agentModelInstalled: boolean | undefined;
  // Anti-loop counters for the colgrep-first guard (per session).
  const guardBlockCounts = new Map<string, number>();
  // Shared adoption metrics across all sessions on this machine.
  const statsPath = getStatsPath(getAgentDir());
  // Machine-wide concurrency protection (shared with every other Pi session
  // on this machine via lock files): a mesh swarm must not launch N parallel
  // searches, index builds, or ~4 GB agent runs at once.
  const slotsDir = join(getAgentDir(), "extensions", "pi-colgrep", "slots");
  const slotWaitMs = () =>
    sessionConfig?.concurrency.waitMs ?? DEFAULT_CONFIG.concurrency.waitMs;
  const withSearchSlot = createSlotRunner(
    createSlotLimiter({
      dir: slotsDir,
      name: "search",
      max: () =>
        sessionConfig?.concurrency.searchMax ??
        DEFAULT_CONFIG.concurrency.searchMax,
    }),
    slotWaitMs,
  );
  const withAgentSlot = createSlotRunner(
    createSlotLimiter({
      dir: slotsDir,
      name: "agent",
      max: () =>
        sessionConfig?.concurrency.agentMax ??
        DEFAULT_CONFIG.concurrency.agentMax,
    }),
    slotWaitMs,
  );
  const withInitSlot = createSlotRunner(
    createSlotLimiter({
      dir: slotsDir,
      name: "init",
      max: () =>
        sessionConfig?.concurrency.initMax ??
        DEFAULT_CONFIG.concurrency.initMax,
    }),
    slotWaitMs,
  );

  const exec = (
    cmd: string,
    args: string[],
    opts?: { cwd?: string; timeout?: number; signal?: AbortSignal },
  ) => pi.exec(cmd, args, opts);

  // Cold-build size guard: refuse to auto-index oversized directories.
  const preflightIndex = async (cwd: string): Promise<string | undefined> => {
    if (indexExists) return undefined;
    const max =
      sessionConfig?.indexing.maxFiles ?? DEFAULT_CONFIG.indexing.maxFiles;
    if (max <= 0) return undefined;
    const count = await countFilesUpTo(exec, cwd, max);
    if (exceedsCap(count, max)) {
      return tooLargeMessage(cwd, count ?? max + 1, max);
    }
    return undefined;
  };

  const buildReindexer = (ctx: UiCtxLike, config: ColGrepConfig): Reindexer =>
    createReindexer({
      exec,
      cwd: ctx.cwd,
      onStatus: (text) => setIndexWidget(ctx, text ? [text] : undefined),
      withInitSlot,
      timeoutMs: config.concurrency.initTimeoutMs,
      maxIndexableFiles: () => config.indexing.maxFiles,
      onTooLarge: (count, max) => {
        setIndexWidget(ctx, undefined);
        ctx.ui.notify(tooLargeMessage(ctx.cwd, count, max), "info");
      },
      builder: () =>
        runIndexBuild({
          cwd: ctx.cwd,
          args: ["init", "-y", "."],
          timeoutMs: config.concurrency.initTimeoutMs,
          logPath: join(tmpdir(), `colgrep-build-${process.pid}.log`),
          onProgress: ({ current, total, percent }) => {
            const suffix =
              percent !== undefined &&
              current !== undefined &&
              total !== undefined
                ? `${percent}% (${current.toLocaleString("en-US")}/${total.toLocaleString("en-US")})`
                : "…";
            setIndexWidget(ctx, [
              `colgrep: indexing ${basename(ctx.cwd)} ${suffix}`,
            ]);
          },
        }),
    });

  registerColGrep(pi, {
    exec,
    availability,
    waitForIndexIdle: () => reindexer?.whenIdle() ?? Promise.resolve(),
    withSearchSlot,
    preflightIndex,
  });
  registerColGrepAgent(pi, {
    exec,
    availability,
    isModelInstalled: () => agentModelInstalled,
    isEnabled: () => sessionConfig?.agent.enabled ?? true,
    maxConcurrent: () => sessionConfig?.agent.maxConcurrent ?? 1,
    timeoutMs: () => sessionConfig?.agent.timeoutMs,
    waitForIndexIdle: () => reindexer?.whenIdle() ?? Promise.resolve(),
    withAgentSlot,
    preflightIndex,
  });

  pi.on("session_start", async (_event, ctx) => {
    await availability.refresh(exec);

    if (!availability.available) {
      ctx.ui.notify(
        "colgrep is not installed. Semantic code search will not be available.\n" +
          "Install from: https://github.com/lightonai/next-plaid#installation",
        "warning",
      );
      return;
    }

    const config = loadConfig({
      globalConfigPath: getGlobalConfigPath(getAgentDir()),
      projectConfigPath: getProjectConfigPath(ctx.cwd),
    });
    sessionConfig = config;

    unsafeRoot = isUnsafeIndexRoot(ctx.cwd);
    if (unsafeRoot) {
      ctx.ui.notify(unsafeRootMessage(ctx.cwd), "info");
    }

    // Fast, offline probe (HF cache size check — no subprocess, no agent run).
    agentModelInstalled = await isAgentModelInstalled();
    if (!agentModelInstalled && config.agent.enabled) {
      ctx.ui.notify(
        "colgrep: agent model not installed — colgrep_agent is unavailable.\n" +
          "One-time setup: run /colgrep-agent-install (downloads ~2.5 GB).",
        "info",
      );
    }

    reindexer = buildReindexer(ctx, config);

    skipWarned = false;
    guardBlockCounts.clear();
    indexExists = await checkIndexExists(exec, ctx.cwd);

    if (config.indexOnStartup && !indexExists && !unsafeRoot) {
      // First time only: when an index already exists, skip the startup build
      // (searches auto-update modified files). This avoids reindex storms
      // when several agents share the same large directory. `skipIfExists`
      // re-probes after the slot is acquired, so a swarm queued on the same
      // repo does not rebuild what the first session just built.
      void reindexer.runNow({ waitMs: 300_000, skipIfExists: true });
      indexExists = true;
    }
  });

  // colgrep-first guard (config-gated; also the adoption counter when off).
  pi.on("tool_call", (event) => {
    const config = sessionConfig;
    if (!config) return undefined;
    if (event.toolName !== "bash") return undefined;

    const command = (event.input as { command?: unknown }).command;
    if (typeof command !== "string" || command.trim() === "") return undefined;

    const decision = classifyBashCommand(
      command,
      { mode: config.guard.mode, allowGitGrep: config.guard.allowGitGrep },
      guardBlockCounts,
    );
    if (decision.detected) {
      recordStat(
        statsPath,
        decision.action === "block" ? "grep_blocked" : "grep_allowed",
      );
    }
    if (decision.action === "block") {
      return { block: true, reason: decision.reason };
    }
    return undefined;
  });

  pi.on("tool_result", (event, ctx) => {
    if (!event.isError && event.toolName === "colgrep") {
      recordStat(statsPath, "search");
      // A successful search implies an index now exists (auto-built on demand).
      indexExists = true;
    }
    if (!event.isError && event.toolName === "colgrep_agent") {
      recordStat(statsPath, "agent_run");
      indexExists = true;
    }

    if (event.isError) return;
    if (event.toolName !== "write" && event.toolName !== "edit") return;
    if (unsafeRoot) return;
    if (!indexExists) {
      if (!skipWarned) {
        skipWarned = true;
        ctx.ui.notify(
          "colgrep: skipping auto-reindex — no index for this directory. " +
            "Run /colgrep-reindex to build one.",
          "info",
        );
      }
      return;
    }
    reindexer?.schedule();
  });

  pi.on("session_shutdown", async (_event, _ctx) => {
    await reindexer?.shutdown();
    reindexer = undefined;
    sessionConfig = undefined;
    unsafeRoot = false;
    guardBlockCounts.clear();
  });

  pi.registerCommand("colgrep-reindex", {
    description: "Manually refresh the ColGrep semantic search index",
    handler: async (_args, ctx) => {
      if (!availability.available) {
        ctx.ui.notify(
          "colgrep is not installed. Install from: https://github.com/lightonai/next-plaid#installation",
          "warning",
        );
        return;
      }

      if (unsafeRoot) {
        ctx.ui.notify(unsafeRootMessage(ctx.cwd), "warning");
        return;
      }

      // Use the session reindexer if available; otherwise create a one-shot
      // one (e.g., if the command is invoked before session_start has run).
      const indexer =
        reindexer ?? buildReindexer(ctx, sessionConfig ?? DEFAULT_CONFIG);

      await indexer.runNow({ waitMs: 300_000 });
      // A manual reindex establishes an index, so resume write/edit reindexing.
      indexExists = true;
      ctx.ui.notify("ColGrep index updated.", "info");
    },
  });

  pi.registerCommand("colgrep-stats", {
    description:
      "Show colgrep-first adoption counters (searches, agent runs, recursive greps)",
    handler: async (_args, ctx) => {
      ctx.ui.notify(formatStatsSummary(summarizeStats(statsPath)), "info");
    },
  });

  pi.registerCommand("colgrep-agent-install", {
    description:
      "Download the colgrep-agent-2B model (~2.5 GB, one-time) for colgrep_agent",
    handler: async (_args, ctx) => {
      if (!availability.available) {
        ctx.ui.notify(
          "colgrep is not installed. Install from: https://github.com/lightonai/next-plaid#installation",
          "warning",
        );
        return;
      }

      ctx.ui.notify(
        "colgrep: downloading the agent model (~2.5 GB, one time). " +
          "The session stays usable; this runs in the background of the terminal.",
        "info",
      );
      setIndexWidget(ctx, ["colgrep: agent install … (one-time, ~2.5 GB)"]);

      let succeeded = false;
      try {
        const result = await exec("colgrep", ["--install-agent"], {
          cwd: ctx.cwd,
          timeout: AGENT_INSTALL_TIMEOUT_MS,
        });
        succeeded = result.code === 0;
        if (!succeeded) {
          const detail = result.stderr.trim();
          ctx.ui.notify(
            `colgrep: agent model install failed${detail ? `: ${detail}` : ` (exit code ${result.code})`}`,
            "error",
          );
        }
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        ctx.ui.notify(`colgrep: agent model install failed: ${reason}`, "error");
      } finally {
        setIndexWidget(ctx, undefined);
      }

      if (succeeded) {
        agentModelInstalled = await isAgentModelInstalled();
        ctx.ui.notify(
          "colgrep: agent model installed — colgrep_agent is ready.",
          "info",
        );
      }
    },
  });
}
