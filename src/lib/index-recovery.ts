/**
 * Self-healing for corrupted colgrep indexes.
 *
 * A build killed mid-write (exec timeout, session end, machine pressure)
 * leaves a partial index directory: `.building` plus an `index/` folder with
 * no `metadata.json`. colgrep then fails with "Index load failed: Failed to
 * open metadata" when it tries to resume/use it, and the failure repeats on
 * every session.
 *
 * Recovery: locate the project's index via `colgrep status`, verify the path
 * is inside colgrep's own indices directory (hard safety guard before any
 * recursive delete), and remove it so the next build starts clean.
 */
import { rmSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { Exec } from "./exec";

const RECOVERABLE_PATTERN = /Index load failed|Failed to open metadata|corrupt/i;

/** True when the output indicates a corrupted/partial index state. */
export function isRecoverableIndexError(output: string): boolean {
  return RECOVERABLE_PATTERN.test(output);
}

/** Parse the `Index: <path>` line from `colgrep status` output. */
export function parseIndexPath(statusStdout: string): string | undefined {
  const match = /^Index:\s*(.+)$/m.exec(statusStdout);
  const value = match?.[1]?.trim();
  return value ? value : undefined;
}

/** colgrep's data directory (macOS first, Linux fallback). */
export function getColgrepDataDir(home: string = homedir()): string {
  if (process.platform === "darwin") {
    return join(home, "Library", "Application Support", "colgrep");
  }
  return join(home, ".local", "share", "colgrep");
}

/**
 * Safety guard: only paths strictly inside `<indicesRoot>/` may be deleted.
 * A bare root or anything outside it is refused.
 */
export function isSafeIndexPath(
  indexPath: string,
  indicesRoot: string,
): boolean {
  const resolved = resolve(indexPath);
  const root = resolve(indicesRoot);
  return resolved !== root && resolved.startsWith(`${root}/`);
}

/**
 * Remove the corrupted index for `cwd` (best effort).
 * Returns the removed path, or undefined when nothing was removed.
 */
export async function recoverCorruptedIndex(
  exec: Exec,
  cwd: string,
  options: { indicesRoot?: string } = {},
): Promise<string | undefined> {
  let stdout: string;
  try {
    const status = await exec("colgrep", ["status", cwd, "--color", "never"], {
      cwd,
      timeout: 5_000,
    });
    if (status.code !== 0) return undefined;
    stdout = status.stdout;
  } catch {
    return undefined;
  }

  const indexPath = parseIndexPath(stdout);
  if (!indexPath) return undefined;

  const indicesRoot =
    options.indicesRoot ?? join(getColgrepDataDir(), "indices");
  if (!isSafeIndexPath(indexPath, indicesRoot)) return undefined;

  try {
    rmSync(indexPath, { recursive: true, force: true });
  } catch {
    return undefined;
  }
  return indexPath;
}
