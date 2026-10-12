import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { isAgentModelInstalled } from "./lib/agent";
import { createAvailabilityState } from "./lib/availability";
import {
  getGlobalConfigPath,
  getProjectConfigPath,
  loadConfig,
  type ColGrepConfig,
} from "./lib/config";
import { classifyBashCommand } from "./lib/guard";
import { checkIndexExists } from "./lib/index-status";
import { createReindexer, type Reindexer } from "./lib/reindex";
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

  const exec = (
    cmd: string,
    args: string[],
    opts?: { cwd?: string; timeout?: number; signal?: AbortSignal },
  ) => pi.exec(cmd, args, opts);

  registerColGrep(pi, { exec, availability });
  registerColGrepAgent(pi, {
    exec,
    availability,
    isModelInstalled: () => agentModelInstalled,
    isEnabled: () => sessionConfig?.agent.enabled ?? true,
    maxConcurrent: () => sessionConfig?.agent.maxConcurrent ?? 1,
    timeoutMs: () => sessionConfig?.agent.timeoutMs,
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
    });

    skipWarned = false;
    guardBlockCounts.clear();
    indexExists = await checkIndexExists(exec, ctx.cwd);

    if (config.indexOnStartup) {
      // Fire-and-forget: kick the index build off in the background so it never
      // blocks Pi startup. `shutdown()` awaits the in-flight run on session end.
      void reindexer.runNow();
      indexExists = true;
    }
  });

  // colgrep-first guard (config-gated, default off: the agent decides).
  pi.on("tool_call", (event) => {
    const config = sessionConfig;
    if (!config || config.guard.mode === "off") return undefined;
    if (event.toolName !== "bash") return undefined;

    const command = (event.input as { command?: unknown }).command;
    if (typeof command !== "string" || command.trim() === "") return undefined;

    const decision = classifyBashCommand(
      command,
      { mode: config.guard.mode, allowGitGrep: config.guard.allowGitGrep },
      guardBlockCounts,
    );
    if (decision.action === "block") {
      return { block: true, reason: decision.reason };
    }
    return undefined;
  });

  pi.on("tool_result", (event, ctx) => {
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
        });

      await indexer.runNow();
      // A manual reindex establishes an index, so resume write/edit reindexing.
      indexExists = true;
      ctx.ui.notify("ColGrep index updated.", "info");
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
