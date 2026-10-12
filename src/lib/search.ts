import { buildSearchArgs, type SearchParams } from "./args";
import type { Exec } from "./exec";
import { formatResults } from "./format";

export interface SearchResult {
  /** Formatted hit lines, present on success. */
  output?: string;
  /** Error message, present on failure. */
  error?: string;
}

/** colgrep's error while another process is building the index. */
const INDEX_BUILDING_PATTERN = /index is currently being built/i;

/** Total time to keep retrying a search while the index is being built. */
export const INDEX_BUILDING_RETRY_BUDGET_MS = 120_000;

const INITIAL_RETRY_DELAY_MS = 2_000;
const MAX_RETRY_DELAY_MS = 30_000;

export interface RunSearchOptions {
  /** Retry budget for index-build contention (default 120 s). */
  retryBudgetMs?: number;
  /** Notified before each retry wait (attempt number, delay in ms). */
  onRetry?: (attempt: number, delayMs: number) => void;
  /** Injectable sleep for tests. */
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Run a colgrep search and return formatted results.
 *
 * Paths in the output are relativized against `params.path` when provided,
 * otherwise against `cwd`.
 *
 * While another colgrep process is building the index, searches fail fast
 * with "index is currently being built, rely on grep for now". That message
 * invites a grep fallback, against the colgrep-first policy, so this function
 * retries with exponential backoff for up to `retryBudgetMs` (default 2 min —
 * covering most first-time builds) before surfacing an actionable error.
 */
export async function runSearch(
  exec: Exec,
  params: SearchParams,
  cwd: string,
  signal?: AbortSignal,
  options: RunSearchOptions = {},
): Promise<SearchResult> {
  const args = buildSearchArgs(params);
  const searchDir = params.path ?? cwd;
  const budgetMs = options.retryBudgetMs ?? INDEX_BUILDING_RETRY_BUDGET_MS;
  const sleep = options.sleep ?? defaultSleep;

  let waitedMs = 0;
  let attempt = 0;
  let delayMs = INITIAL_RETRY_DELAY_MS;

  for (;;) {
    const result = await exec("colgrep", args, { cwd, signal });

    if (result.code === 0) {
      return { output: formatResults(result.stdout, searchDir) };
    }

    const detail = result.stderr.trim() || result.stdout.trim();
    const indexBuilding =
      INDEX_BUILDING_PATTERN.test(result.stderr) ||
      INDEX_BUILDING_PATTERN.test(result.stdout);

    if (!indexBuilding) {
      return {
        error: detail || `colgrep exited with exit code ${result.code}`,
      };
    }

    if (signal?.aborted) {
      return { error: "Search aborted while the colgrep index was building." };
    }

    if (waitedMs >= budgetMs) {
      const seconds = Math.round(budgetMs / 1000);
      return {
        error:
          `${detail}\n` +
          `(The colgrep index build is still running after ${seconds}s — ` +
          `first-time indexing of a large directory. The build continues in ` +
          `the background: retry this search in a moment with colgrep ` +
          `instead of falling back to recursive grep.)`,
      };
    }

    attempt += 1;
    const waitMs = Math.min(delayMs, budgetMs - waitedMs);
    options.onRetry?.(attempt, waitMs);
    await sleep(waitMs);
    waitedMs += waitMs;
    delayMs = Math.min(delayMs * 2, MAX_RETRY_DELAY_MS);
  }
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
