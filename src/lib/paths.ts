/**
 * Path-safety guards for indexing and searching.
 *
 * Sessions are sometimes launched from the home directory (or "/"), where a
 * colgrep index would try to cover the entire machine: useless, CPU/IO-heavy
 * for hours, and it pollutes the index store. These roots must never be
 * auto-indexed nor searched by the tools.
 */
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";

/**
 * True when `cwd` is a directory that must never be indexed/searched:
 * the home directory, its parent (e.g. `/Users`, `/home`), or `/`.
 */
export function isUnsafeIndexRoot(
  cwd: string,
  home: string = homedir(),
): boolean {
  const resolved = resolve(cwd);
  const resolvedHome = resolve(home);
  if (resolved === resolvedHome) return true;
  if (resolved === dirname(resolvedHome)) return true;
  return resolved === "/";
}

/** User-facing explanation for the refusal. */
export function unsafeRootMessage(cwd: string): string {
  return (
    `colgrep refuses to index or search ${cwd} (home directory / root): it ` +
    `would cover the whole machine and run for hours. Run Pi from a project ` +
    `directory, or scope the search to a project subdirectory.`
  );
}
