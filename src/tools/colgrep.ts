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
import type { SearchParams } from "#src/lib/args";
import type { AvailabilityState } from "#src/lib/availability";
import type { Exec } from "#src/lib/exec";
import {
  isRecoverableIndexError,
  recoverCorruptedIndex,
} from "#src/lib/index-recovery";
import { runSearch } from "#src/lib/search";
import type { SlotRunner } from "#src/lib/slots";
import { err, ok, previewBlock } from "#src/tool-result";

export interface ColGrepToolDetails {
  hitCount: number;
  truncated: boolean;
  fullOutputPath?: string;
}

export interface ColGrepExecuteDeps {
  exec: Exec;
  availability: AvailabilityState;
  /** Awaited before searching: joins an in-flight reindex in this session. */
  waitForIndexIdle?: () => Promise<void>;
  /** Machine-wide search slot (shared across all Pi sessions). */
  withSearchSlot?: SlotRunner;
  /** Self-heal hook for corrupted indexes (tests); defaults to real recovery. */
  recoverIndex?: (exec: Exec, cwd: string) => Promise<string | undefined>;
  /** Override default truncation line limit. Used in tests. */
  maxLines?: number;
  /** Override default truncation byte limit. Used in tests. */
  maxBytes?: number;
}

/**
 * Core execute logic, extracted for testability.
 * Called by the tool's `execute()` callback with `ctx.cwd` as cwd.
 */
export async function executeColGrepSearch(
  params: SearchParams,
  deps: ColGrepExecuteDeps,
  cwd: string,
  signal: AbortSignal | undefined,
) {
  if (!deps.availability.available) {
    return err(
      "colgrep is not installed or not available.\n" +
        "Install it from: https://github.com/lightonai/next-plaid#installation",
    );
  }

  if (!params.query && !params.regex) {
    return err("At least one of query or regex is required.");
  }

  // Join an in-flight reindex (session startup or post-edit) instead of
  // racing it: a build in progress makes searches fail fast otherwise.
  if (deps.waitForIndexIdle) {
    await deps.waitForIndexIdle();
  }

  const runOnce = () =>
    deps.withSearchSlot
      ? deps.withSearchSlot(() =>
          runSearch(deps.exec, params, cwd, signal),
        )
      : runSearch(deps.exec, params, cwd, signal);

  let searchResult = await runOnce();
  if (searchResult === undefined) {
    return err(
      "colgrep is at capacity (machine-wide search limit reached). " +
        "Retry in a moment.",
    );
  }

  if (searchResult.error && isRecoverableIndexError(searchResult.error)) {
    // Self-heal: an interrupted build left a partial index ("Failed to open
    // metadata"). Remove it and retry once — the retry rebuilds the index.
    const recover = deps.recoverIndex ?? recoverCorruptedIndex;
    const removed = await recover(deps.exec, cwd);
    if (removed) {
      searchResult = await runOnce();
      if (searchResult === undefined) {
        return err(
          "colgrep is at capacity (machine-wide search limit reached). " +
            "Retry in a moment.",
        );
      }
    }
  }

  if (searchResult.error) {
    return err(searchResult.error);
  }

  const output = searchResult.output ?? "No matches found";
  const maxLines = deps.maxLines ?? DEFAULT_MAX_LINES;
  const maxBytes = deps.maxBytes ?? DEFAULT_MAX_BYTES;
  const truncation = truncateHead(output, { maxLines, maxBytes });

  if (truncation.truncated) {
    const tempPath = join(tmpdir(), `colgrep-${Date.now()}.txt`);
    await writeFile(tempPath, output);
    const hitCount = countHits(output);
    return ok(`${truncation.content}\n[Truncated. Full output: ${tempPath}]`, {
      hitCount,
      truncated: true,
      fullOutputPath: tempPath,
    } satisfies ColGrepToolDetails);
  }

  const hitCount = countHits(output);
  return ok(output, {
    hitCount,
    truncated: false,
  } satisfies ColGrepToolDetails);
}

export interface RegisterColGrepDeps {
  exec: Exec;
  availability: AvailabilityState;
  /** Awaited before searching: joins an in-flight reindex in this session. */
  waitForIndexIdle?: () => Promise<void>;
  /** Machine-wide search slot (shared across all Pi sessions). */
  withSearchSlot?: SlotRunner;
}

export function registerColGrep(
  pi: ExtensionAPI,
  deps: RegisterColGrepDeps,
): void {
  pi.registerTool({
    name: "colgrep",
    label: "ColGrep",
    description:
      "PRIMARY code search tool: semantic / hybrid search (ColBERT embeddings + tree-sitter) over the auto-indexed repository. " +
      "Use it by default to find code — by intent (query) or exact pattern (regex; pattern search is exhaustive). " +
      "At least one of query or regex is required. " +
      "For open-ended localization questions, use the colgrep_agent tool instead.",
    promptSnippet:
      "Default code search — find code by intent or exhaustive pattern match.",
    promptGuidelines: [
      "colgrep is the DEFAULT search tool for finding code and file content: prefer it over grep/rg for exploration and lookups.",
      "Find code by intent with a natural-language query; find exact patterns or symbols with regex — pattern search (-e) is exhaustive, making it the right tool for 'all usages of X'.",
      "Use grep/rg only for: filtering other commands' output (pipes), paths outside the repository, or when no colgrep index can be built.",
      "For open-ended 'where is X implemented/handled' questions, use colgrep_agent — it delegates exploration to a local model and returns file:line locations.",
      "Increase limit when exploring a large codebase (e.g. limit=30) for broader coverage.",
    ],
    parameters: Type.Object({
      query: Type.Optional(
        Type.String({
          description: "Semantic search query (natural language intent)",
        }),
      ),
      regex: Type.Optional(
        Type.String({
          description:
            "Regex pre-filter applied before semantic ranking (-e flag)",
        }),
      ),
      path: Type.Optional(
        Type.String({
          description: "Directory or file to search (defaults to cwd)",
        }),
      ),
      glob: Type.Optional(
        Type.String({ description: "Include glob pattern (--include flag)" }),
      ),
      limit: Type.Optional(
        Type.Number({
          description: "Max results (-k flag; colgrep's default applies when omitted)",
        }),
      ),
      context: Type.Optional(
        Type.Number({ description: "Context lines (-n flag)" }),
      ),
    }),
    renderCall(args, theme, context) {
      const text =
        (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
      text.setText(formatCall(args, theme));
      return text;
    },
    renderResult(result, options, theme, context) {
      const text =
        (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
      text.setText(formatResult(result, options, theme, context.isError));
      return text;
    },
    async execute(
      _toolCallId,
      params,
      signal,
      _onUpdate,
      ctx: ExtensionContext,
    ) {
      return executeColGrepSearch(params, deps, ctx.cwd, signal);
    },
  });
}

// ---- rendering helpers ----

function formatCall(args: Record<string, unknown>, theme: Theme): string {
  const query = typeof args.query === "string" ? args.query : undefined;
  const regex = typeof args.regex === "string" ? args.regex : undefined;
  const path = typeof args.path === "string" ? args.path : ".";
  const limit = typeof args.limit === "number" ? args.limit : undefined;

  const parts: string[] = [theme.fg("toolTitle", theme.bold("colgrep"))];
  if (query) parts.push(theme.fg("accent", `"${query}"`));
  if (regex) parts.push(theme.fg("accent", `-e /${regex}/`));
  parts.push(
    theme.fg("toolOutput", `in ${path}${limit !== undefined ? ` (k=${limit})` : ""}`),
  );
  return parts.join(" ");
}

interface AnyToolResult {
  content: Array<{ type: string; text?: string }>;
  details?: ColGrepToolDetails;
}

function formatResult(
  result: unknown,
  options: { expanded: boolean },
  theme: Theme,
  isError: boolean,
): string {
  const r = result as AnyToolResult;
  const details = r.details;
  const hitCount = details?.hitCount ?? 0;
  const outputText =
    r.content[0]?.type === "text" ? (r.content[0].text ?? "") : "";

  if (!options.expanded && isError) {
    const firstLine = outputText.split("\n")[0] ?? "";
    return `${theme.fg("error", "✗")} ${theme.fg("error", firstLine)}`;
  }

  if (!options.expanded) {
    const icon = theme.fg("success", "✓");
    if (hitCount === 0) {
      return `${icon} ${theme.fg("muted", "no matches")}`;
    }
    const count = theme.fg(
      "muted",
      `${hitCount} hit${hitCount === 1 ? "" : "s"}`,
    );
    const truncated = details?.truncated
      ? theme.fg("warning", " (truncated)")
      : "";
    const lines = outputText.split("\n").filter((line) => line !== "");
    return `${icon} ${count}${truncated}${previewBlock(lines, theme)}`;
  }

  const lines = outputText
    .split("\n")
    .map((l: string) => theme.fg("toolOutput", `  ${l}`));
  return lines.join("\n");
}

// ---- private helpers ----

function countHits(output: string): number {
  if (output === "No matches found") return 0;
  return output.split("\n").length;
}
