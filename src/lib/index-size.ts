/**
 * Size guard for automatic indexing.
 *
 * Some directories are simply not indexable in practice: a 30k-file workspace
 * (datasets, experiment dumps, mesh state) takes minutes to index, saturates
 * CPU/IO, and produces a fragile index. Before a *cold* build (no index yet),
 * count files with a bounded scan that stops early once the cap is exceeded,
 * so the check is cheap even on huge trees.
 */
import type { Exec } from "./exec";

/** Default cap for automatic indexing. */
export const DEFAULT_MAX_INDEXABLE_FILES = 20_000;

/**
 * POSIX shell command counting regular files (pruning noise directories),
 * capped at `max + 1` so `head` can stop `find` early on huge trees.
 */
export function buildCountCommand(max: number): string {
  const prune =
    "\\( -name .git -o -name node_modules -o -name .mesh -o -name dist -o -name build -o -name .venv -o -name __pycache__ -o -name target \\) -prune";
  return `find . ${prune} -o -type f -print 2>/dev/null | head -n ${max + 1} | wc -l`;
}

/**
 * Count files up to `max + 1`. Returns undefined when the scan failed or
 * timed out — callers then index normally (fail open).
 */
export async function countFilesUpTo(
  exec: Exec,
  dir: string,
  max: number,
  timeoutMs = 5_000,
): Promise<number | undefined> {
  try {
    const result = await exec("/bin/sh", ["-c", buildCountCommand(max)], {
      cwd: dir,
      timeout: timeoutMs,
    });
    if (result.code !== 0) return undefined;
    const count = Number.parseInt(result.stdout.trim(), 10);
    return Number.isFinite(count) ? count : undefined;
  } catch {
    return undefined;
  }
}

/** True when the counted value means the directory exceeds the cap. */
export function exceedsCap(count: number | undefined, max: number): boolean {
  return count !== undefined && max > 0 && count > max;
}

/** User-facing explanation for the refusal. */
export function tooLargeMessage(
  dir: string,
  count: number,
  max: number,
): string {
  return (
    `colgrep: ${dir} has more than ${max.toLocaleString("en-US")} files ` +
    `(counted ${count.toLocaleString("en-US")} in the first pass) — indexing ` +
    `it automatically would run for a very long time. Search a project ` +
    `subdirectory instead, or raise indexing.maxFiles in the pi-colgrep config.`
  );
}
