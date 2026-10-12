/**
 * ColGrep agent mode (`colgrep --agent`) integration.
 *
 * The agent is a small local model (colgrep-agent-2B) that iteratively
 * searches the repository with colgrep and reads files (read-only), then
 * returns the relevant `file:line` locations for an open-ended question
 * (bug report, feature request, "where is X implemented").
 *
 * JSON schema captured from colgrep 1.8.5 (see PLAN.md section 6):
 * {
 *   "query": "...",
 *   "locations": [{ "file": "/abs/path/file.ts", "start_line": N, "end_line": M }],
 *   "submitted": true,
 *   "end_reason": "Answered",
 *   "error": null,
 *   "turns": 3, "searches": 1, "reads": 1,
 *   "prompt_tokens": 5953, "cached_prompt_tokens": 4332, "completion_tokens": 161,
 *   "llm_seconds": 6.48, "tool_seconds": 0.19, "seconds": 20.83
 * }
 *
 * Notes from the live capture:
 * - `file` is an ABSOLUTE path (relativized by the tool formatter).
 * - `-c` with `--json` does NOT add content: locations only is the stable shape.
 * - stderr carries no progress when stdout is not a TTY.
 */
import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, relative } from "node:path";
import type { Exec } from "./exec";

export interface AgentParams {
  question: string;
  path?: string;
}

export interface AgentLocation {
  file: string;
  startLine: number;
  endLine: number;
}

export interface AgentMeta {
  turns: number;
  searches: number;
  reads: number;
  seconds: number;
  submitted: boolean;
  endReason: string;
}

export type AgentParseOutcome =
  | { kind: "ok"; locations: AgentLocation[]; meta: AgentMeta }
  | { kind: "agent_error"; message: string }
  | { kind: "unparsable"; raw: string };

/** HF repo directory name created by `colgrep --install-agent`. */
export const AGENT_MODEL_HF_DIR = "models--lightonai--colgrep-agent-2B-GGUF";

/** The Q8_0 GGUF is ~2.5 GB; anything at least this large is the model. */
export const AGENT_MODEL_MIN_BYTES = 1_500_000_000;

export function buildAgentArgs(params: AgentParams): string[] {
  const args: string[] = ["--agent", "--json"];
  args.push(params.question);
  if (params.path !== undefined) {
    args.push(params.path);
  }
  return args;
}

/**
 * Parse `colgrep --agent --json` stdout.
 *
 * Defensive by design: a malformed payload falls back to `unparsable` so the
 * caller can still surface the raw text, and individual malformed locations
 * are skipped instead of failing the whole run.
 */
export function parseAgentResult(stdout: string): AgentParseOutcome {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return { kind: "unparsable", raw: stdout };
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { kind: "unparsable", raw: stdout };
  }

  const record = parsed as Record<string, unknown>;

  if (typeof record.error === "string" && record.error.trim() !== "") {
    return { kind: "agent_error", message: record.error.trim() };
  }

  if (!Array.isArray(record.locations)) {
    return { kind: "unparsable", raw: stdout };
  }

  const locations: AgentLocation[] = [];
  for (const item of record.locations) {
    if (typeof item !== "object" || item === null) continue;
    const entry = item as Record<string, unknown>;
    if (
      typeof entry.file === "string" &&
      typeof entry.start_line === "number" &&
      typeof entry.end_line === "number"
    ) {
      locations.push({
        file: entry.file,
        startLine: entry.start_line,
        endLine: entry.end_line,
      });
    }
  }

  return {
    kind: "ok",
    locations,
    meta: {
      turns: numberOr(record.turns, 0),
      searches: numberOr(record.searches, 0),
      reads: numberOr(record.reads, 0),
      seconds: numberOr(record.seconds, 0),
      submitted: record.submitted === true,
      endReason: typeof record.end_reason === "string" ? record.end_reason : "",
    },
  };
}

/**
 * Format one location as `relative/path.ts:START-END`, relativized against
 * `cwd`. Files outside `cwd` keep their absolute path for clarity.
 */
export function formatAgentLocation(
  location: AgentLocation,
  cwd: string,
): string {
  const rel = relative(cwd, location.file);
  const displayPath =
    isAbsolute(rel) || rel.startsWith("..") ? location.file : rel;
  return `${displayPath}:${location.startLine}-${location.endLine}`;
}

/** Format every location, one per line. */
export function formatAgentLocations(
  locations: AgentLocation[],
  cwd: string,
): string {
  return locations
    .map((location) => formatAgentLocation(location, cwd))
    .join("\n");
}

export interface AgentModelCheckOptions {
  /** Override the HuggingFace hub directory (tests). */
  hfHubDir?: string;
  /** Override the minimum size in bytes (tests). */
  minBytes?: number;
}

export function getHfHubDir(home: string = homedir()): string {
  const override = process.env.HF_HOME;
  if (override && override.trim() !== "") {
    return join(override, "hub");
  }
  return join(home, ".cache", "huggingface", "hub");
}

/**
 * Fast, offline check for the agent model in the HuggingFace cache.
 *
 * The blob has no extension (named by SHA256), so detection is a size check:
 * any file in the model's `blobs/` directory at least `minBytes` large is the
 * GGUF. No `colgrep` process is spawned and no agent run is performed.
 */
export async function isAgentModelInstalled(
  options: AgentModelCheckOptions = {},
): Promise<boolean> {
  const blobsDir = join(
    options.hfHubDir ?? getHfHubDir(),
    AGENT_MODEL_HF_DIR,
    "blobs",
  );
  const minBytes = options.minBytes ?? AGENT_MODEL_MIN_BYTES;

  let entries: string[];
  try {
    entries = await readdir(blobsDir);
  } catch {
    return false;
  }

  for (const entry of entries) {
    try {
      const info = await stat(join(blobsDir, entry));
      if (info.isFile() && info.size >= minBytes) {
        return true;
      }
    } catch {
      // Ignore unreadable entries; keep scanning.
    }
  }
  return false;
}

/**
 * Run a colgrep agent session and return parsed stdout.
 *
 * Kept separate from the tool so tests can drive it with a fake `Exec`.
 */
export async function runAgent(
  exec: Exec,
  params: AgentParams,
  cwd: string,
  options: { timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<
  | { kind: "ok"; locations: AgentLocation[]; meta: AgentMeta }
  | { kind: "error"; message: string }
> {
  let result: { stdout: string; stderr: string; code: number };
  try {
    result = await exec("colgrep", buildAgentArgs(params), {
      cwd,
      timeout: options.timeoutMs,
      signal: options.signal,
    });
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return { kind: "error", message: `colgrep --agent failed: ${reason}` };
  }

  if (result.code !== 0) {
    const detail = result.stderr.trim();
    return {
      kind: "error",
      message: detail
        ? detail
        : `colgrep --agent exited with exit code ${result.code}`,
    };
  }

  const outcome = parseAgentResult(result.stdout);
  switch (outcome.kind) {
    case "ok":
      return {
        kind: "ok",
        locations: outcome.locations,
        meta: outcome.meta,
      };
    case "agent_error":
      return { kind: "error", message: outcome.message };
    case "unparsable":
      return {
        kind: "error",
        message: `colgrep --agent returned unrecognized output:\n${outcome.raw.slice(0, 500)}`,
      };
  }
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}
