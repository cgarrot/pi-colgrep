import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { isAgentModelInstalled } from "./lib/agent";
import { createAvailabilityState } from "./lib/availability";
import {
  DEFAULT_CONFIG,
  getGlobalConfigPath,
  getProjectConfigPath,
  loadConfig,
  type ColGrepConfig,
} from "./lib/config";
import { classifyBashCommand } from "./lib/guard";
import { checkIndexExists } from "./lib/index-status";
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

const COLGREP_STATUS_KEY = "colgrep";
const AGENT_INSTALL_TIMEOUT_MS = 30 * 60 * 1000;

function setColGrepStatus(
  ctx: { ui: { setStatus?: (key: string, text: string | undefined) => void } },
  text: string | undefined,
): void {
  if (typeof ctx.ui.setStatus === "function") {
    ctx.ui.setStatus(COLGREP_STATUS_KEY, text);
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

  registerColGrep(pi, {
    exec,
    availability,
    waitForIndexIdle: () => reindexer?.whenIdle() ?? Promise.resolve(),
    withSearchSlot,
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

    // Fast, offline probe (HF cache size check — no subprocess, no agent run).
    agentModelInstalled = await isAgentModelInstalled();
    if (!agentModelInstalled && config.agent.enabled) {
      ctx.ui.notify(
        "colgrep: agent model not installed — colgrep_agent is unavailable.\n" +
          "One-time setup: run /colgrep-agent-install (downloads ~2.5 GB).",
        "info",
      );
    }

    reindexer = createReindexer({
      exec,
      cwd: ctx.cwd,
      onStatus: (text) => setColGrepStatus(ctx, text),
      withInitSlot,
    });

    skipWarned = false;
    guardBlockCounts.clear();
    indexExists = await checkIndexExists(exec, ctx.cwd);

    if (config.indexOnStartup && !indexExists) {
      // First time only: when an index already exists, skip the startup build
      // (searches auto-update modified files). This avoids reindex storms
      // when several agents share the same large directory.
      void reindexer.runNow({ waitMs: 300_000 });
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
    }
    if (!event.isError && event.toolName === "colgrep_agent") {
      recordStat(statsPath, "agent_run");
    }

    if (event.isError) return;
    if (event.toolName !== "write" && event.toolName !== "edit") return;
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

      // Use the session reindexer if available; otherwise create a one-shot
      // one (e.g., if the command is invoked before session_start has run).
      const indexer =
        reindexer ??
        createReindexer({
          exec,
          cwd: ctx.cwd,
          onStatus: (text) => setColGrepStatus(ctx, text),
          withInitSlot,
        });

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
      setColGrepStatus(ctx, "colgrep: agent install\u2026");

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
        setColGrepStatus(ctx, undefined);
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
