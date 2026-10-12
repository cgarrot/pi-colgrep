/**
 * The `colgrep_agent` tool: delegate open-ended code localization to the
 * local colgrep-agent-2B model (`colgrep --agent`).
 *
 * The agent searches the repository itself (colgrep + read-only file reads)
 * and returns precise `file:START-END` locations, so the calling model can
 * spend its context on understanding and patching instead of exploring.
 */
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  ExtensionAPI,
  ExtensionContext,
  Theme,
} from "@earendil-works/pi-coding-agent";
import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  truncateHead,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import {
  formatAgentLocations,
  type AgentLocation,
  type AgentMeta,
  type AgentParams,
  runAgent,
} from "#src/lib/agent";
import type { AvailabilityState } from "#src/lib/availability";
import type { Exec } from "#src/lib/exec";
import { err, ok } from "#src/tool-result";

export interface ColGrepAgentDetails {
  locationCount: number;
  turns: number;
  searches: number;
  seconds: number;
  truncated: boolean;
  fullOutputPath?: string;
}

export interface ColGrepAgentExecuteDeps {
  exec: Exec;
  availability: AvailabilityState;
  /** Tri-state: undefined before the first probe, false when the model is missing. */
  isModelInstalled: () => boolean | undefined;
  /** Config-gated switch (agent.enabled). */
  isEnabled: () => boolean;
  /** Per-session concurrency limit (agent.maxConcurrent). */
  maxConcurrent: () => number;
  /** Exec timeout in ms (agent.timeoutMs). */
  timeoutMs: () => number | undefined;
  /** Override default truncation limits. Used in tests. */
  maxLines?: number;
  maxBytes?: number;
}

export function agentUnavailableMessage(): string {
  return (
    "colgrep is not installed or not available.\n" +
    "Install it from: https://github.com/lightonai/next-plaid#installation"
  );
}

export function agentModelMissingMessage(): string {
  return (
    "The colgrep agent model is not installed (one-time setup, ~2.5 GB).\n" +
    "Install it with: colgrep --install-agent\n" +
    "Then retry, or use the colgrep tool for direct semantic search in the meantime."
  );
}

/**
 * Core execute logic, extracted for testability.
 * Called by the tool's `execute()` callback with `ctx.cwd` as cwd.
 */
export async function executeColGrepAgent(
  params: AgentParams,
  deps: ColGrepAgentExecuteDeps,
  cwd: string,
  signal: AbortSignal | undefined,
) {
  if (!deps.isEnabled()) {
    return err(
      "colgrep_agent is disabled in the pi-colgrep configuration (agent.enabled=false).",
    );
  }

  if (deps.availability.available === false) {
    return err(agentUnavailableMessage());
  }

  if (deps.isModelInstalled() === false) {
    return err(agentModelMissingMessage());
  }

  const outcome = await runAgent(deps.exec, params, cwd, {
    timeoutMs: deps.timeoutMs(),
    signal,
  });

  if (outcome.kind === "error") {
    return err(outcome.message);
  }

  const { locations, meta } = outcome;
  if (locations.length === 0) {
    return ok("No locations found.", detailsOf(locations, meta, false));
  }

  const body = formatAgentLocations(locations, cwd);
  const summary = metaSummary(locations.length, meta);

  const maxLines = deps.maxLines ?? DEFAULT_MAX_LINES;
  const maxBytes = deps.maxBytes ?? DEFAULT_MAX_BYTES;
  const truncation = truncateHead(body, { maxLines, maxBytes });

  if (truncation.truncated) {
    const tempPath = join(tmpdir(), `colgrep-agent-${Date.now()}.txt`);
    await writeFile(tempPath, body);
    return ok(
      `${truncation.content}\n[Truncated. Full output: ${tempPath}]\n\n${summary}`,
      detailsOf(locations, meta, true, tempPath),
    );
  }

  return ok(`${body}\n\n${summary}`, detailsOf(locations, meta, false));
}

export interface RegisterColGrepAgentDeps {
  exec: Exec;
  availability: AvailabilityState;
  isModelInstalled: () => boolean | undefined;
  isEnabled: () => boolean;
  maxConcurrent: () => number;
  timeoutMs: () => number | undefined;
}

export function registerColGrepAgent(
  pi: ExtensionAPI,
  deps: RegisterColGrepAgentDeps,
): void {
  // Per-session concurrency limiter: the local 2B model is GPU-bound, so
  // parallel runs would thrash the machine instead of speeding anything up.
  let inFlight = 0;

  pi.registerTool({
    name: "colgrep_agent",
    label: "ColGrep Agent",
    description:
      "Delegate code localization to a local agent (colgrep-agent-2B). " +
      "Give it an open-ended question (bug report, feature request, 'where is X implemented'), " +
      "it searches the repository itself and returns precise file:line locations. " +
      "Takes ~20-90s but saves your context: prefer it over long grep/read exploration chains. " +
      "For quick lookups, use the colgrep tool directly instead.",
    promptSnippet:
      "Local 2B code-localization agent — delegate 'where is this implemented/handled' questions, get file:line back.",
    promptGuidelines: [
      "Use colgrep_agent for open-ended localization: bug reports, feature requests, or 'where is X implemented/handled' questions where the exact terms are unknown.",
      "colgrep_agent runs a local model that searches and reads files itself (~20-90s) and returns file:START-END locations. Prefer one colgrep_agent call over ten exploratory greps and reads.",
      "Do not use colgrep_agent for quick lookups a single colgrep or grep answers directly, and never run the same question twice — read the returned locations instead.",
      "After colgrep_agent returns, continue with read/edit on the returned locations; do not re-derive them with grep.",
    ],
    parameters: Type.Object({
      question: Type.String({
        description:
          "Open-ended question in natural language, e.g. 'why does the export crash on empty files' or 'where are retries configured'",
      }),
      path: Type.Optional(
        Type.String({
          description:
            "Directory or file to scope the search to (defaults to cwd)",
        }),
      ),
    }),
    renderCall(args, theme) {
      return new Text(formatCall(args, theme), 0, 0);
    },
    renderResult(result, options, theme) {
      return new Text(
        formatResult(result, options, theme),
        0,
        0,
      );
    },
    async execute(
      _toolCallId,
      params,
      signal,
      _onUpdate,
      ctx: ExtensionContext,
    ) {
      const limit = Math.max(1, deps.maxConcurrent());
      if (inFlight >= limit) {
        return err(
          "A colgrep_agent run is already in progress in this session. " +
            "Wait for it to finish before starting another.",
        );
      }
      inFlight += 1;
      try {
        return await executeColGrepAgent(params, deps, ctx.cwd, signal);
      } finally {
        inFlight -= 1;
      }
    },
  });
}

// ---- rendering helpers ----

function formatCall(args: Record<string, unknown>, theme: Theme): string {
  const question = typeof args.question === "string" ? args.question : "";
  const path = typeof args.path === "string" ? args.path : undefined;
  const parts: string[] = [
    theme.fg("toolTitle", theme.bold("colgrep_agent")),
    theme.fg("accent", `"${question}"`),
  ];
  if (path) parts.push(theme.fg("toolOutput", `in ${path}`));
  return parts.join(" ");
}

interface AnyToolResult {
  content: Array<{ type: string; text?: string }>;
  details?: ColGrepAgentDetails;
  isError?: boolean;
}

function formatResult(
  result: unknown,
  options: { expanded: boolean },
  theme: Theme,
): string {
  const r = result as AnyToolResult;
  const details = r.details;
  const outputText =
    r.content[0]?.type === "text" ? (r.content[0].text ?? "") : "";

  if (r.isError) {
    const firstLine = outputText.split("\n")[0] ?? "error";
    return `${theme.fg("error", "✗")} ${theme.fg("error", firstLine)}`;
  }

  if (!options.expanded) {
    const count = details?.locationCount ?? 0;
    const metaText = formatMetaCompact(details);
    const label =
      count === 0
        ? theme.fg("muted", "no locations")
        : theme.fg("muted", `${count} location${count === 1 ? "" : "s"}${metaText}`);
    return `${theme.fg("success", "✓")} ${label}`;
  }

  return outputText
    .split("\n")
    .map((line) => theme.fg("toolOutput", `  ${line}`))
    .join("\n");
}

function formatMetaCompact(details?: ColGrepAgentDetails): string {
  if (!details) return "";
  const parts: string[] = [];
  if (details.turns > 0) parts.push(`${details.turns} turns`);
  if (details.seconds > 0) parts.push(`${details.seconds.toFixed(1)}s`);
  return parts.length > 0 ? ` · ${parts.join(" · ")}` : "";
}

// ---- private helpers ----

function detailsOf(
  locations: AgentLocation[],
  meta: AgentMeta,
  truncated: boolean,
  fullOutputPath?: string,
): ColGrepAgentDetails {
  return {
    locationCount: locations.length,
    turns: meta.turns,
    searches: meta.searches,
    seconds: meta.seconds,
    truncated,
    ...(fullOutputPath !== undefined ? { fullOutputPath } : {}),
  };
}

function metaSummary(count: number, meta: AgentMeta): string {
  const parts = [
    `${count} location${count === 1 ? "" : "s"}`,
    `${meta.turns} turn${meta.turns === 1 ? "" : "s"}`,
    `${meta.searches} search${meta.searches === 1 ? "" : "es"}`,
  ];
  if (meta.seconds > 0) parts.push(`${meta.seconds.toFixed(1)}s`);
  return `[colgrep_agent: ${parts.join(" · ")}]`;
}
