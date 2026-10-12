import type { Exec } from "./exec";
import {
  isRecoverableIndexError,
  recoverCorruptedIndex,
} from "./index-recovery";
import type { SlotRunner } from "./slots";

export type ReindexStatusCallback = (status: string | undefined) => void;

export interface ReindexerDeps {
  exec: Exec;
  cwd: string;
  onStatus: ReindexStatusCallback;
  /** Debounce quiet period before a scheduled reindex fires. Defaults to 4000 ms. */
  debounceMs?: number;
  /** Exec timeout for the reindex command. Defaults to 300 000 ms (5 min). */
  timeoutMs?: number;
  /** Machine-wide index-build slot (one build at a time across all sessions). */
  withInitSlot?: SlotRunner;
  /**
   * Self-heal hook for corrupted indexes. Defaults to locating the project's
   * index via `colgrep status` and removing it so a fresh build can run.
   */
  recoverIndex?: (output: string) => Promise<string | undefined>;
}

export interface Reindexer {
  /** Schedule a debounced reindex. Safe to call repeatedly. */
  schedule(): void;
  /**
   * Run a reindex immediately, bypassing debounce. Resolves when complete.
   * `options.waitMs` overrides how long to wait for a machine-wide slot;
   * when no slot is acquired in time the run is skipped.
   */
  runNow(options?: { waitMs?: number }): Promise<void>;
  /** Cancel pending timers and wait for any in-flight reindex to finish. */
  shutdown(): Promise<void>;
  /** Resolves when the current in-flight run (if any) completes. */
  whenIdle(): Promise<void>;
}

const DEFAULT_DEBOUNCE_MS = 4_000;
// First builds of large projects can legitimately exceed five minutes; the
// machine-wide init slot already prevents build stampedes.
const DEFAULT_TIMEOUT_MS = 900_000;
const INDEXING_STATUS = "colgrep: indexing\u2026";
const QUEUED_STATUS = "colgrep: indexing\u2026 (queued updates)";
const INDEXING_FAILED_STATUS = "colgrep: indexing failed";

export function createReindexer(deps: ReindexerDeps): Reindexer {
  const { exec, cwd, onStatus, withInitSlot } = deps;
  const recoverIndex =
    deps.recoverIndex ?? (() => recoverCorruptedIndex(exec, cwd));
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const debounceMs = deps.debounceMs ?? DEFAULT_DEBOUNCE_MS;

  let debounceTimer: ReturnType<typeof setTimeout> | undefined;
  let inFlight = false;
  let queued = false;
  let isShutdown = false;
  let inflightPromise: Promise<void> | undefined;

  async function runReindex(waitMs?: number): Promise<void> {
    inFlight = true;
    onStatus(INDEXING_STATUS);
    let failed = false;
    let skipped = false;

    const attempt = async (): Promise<{ ok: boolean; output: string }> => {
      const result = await exec("colgrep", ["init", "-y", "."], {
        cwd,
        timeout: timeoutMs,
      });
      const output = `${result.stdout}\n${result.stderr}`;
      if (result.code !== 0) {
        const detail = result.stderr.trim();
        console.error(
          `colgrep reindex failed: ${detail || `exit code ${result.code}`}`,
        );
      }
      return { ok: result.code === 0, output };
    };

    const doRun = async (): Promise<void> => {
      let result = await attempt();
      failed = !result.ok;
      if (result.ok || !isRecoverableIndexError(result.output)) return;

      // Self-heal: an interrupted build left a partial index
      // ("Failed to open metadata"). Remove it and rebuild once from scratch.
      const removed = await recoverIndex(result.output);
      if (!removed) return;
      console.warn(
        `colgrep: removed corrupted index at ${removed} — rebuilding`,
      );
      result = await attempt();
      failed = !result.ok;
    };

    try {
      if (withInitSlot) {
        // One index build at a time machine-wide: when another session is
        // already building, skip instead of stacking CPU-heavy builds.
        const ran = await withInitSlot(doRun, waitMs);
        skipped = ran === undefined;
      } else {
        await doRun();
      }
    } catch (err) {
      failed = true;
      console.error("colgrep reindex failed:", err);
    }
    if (failed) {
      onStatus(INDEXING_FAILED_STATUS);
    }
    onStatus(undefined);
    inFlight = false;
    inflightPromise = undefined;

    // Drain: if a reindex was queued while we were running, start it now
    // (unless shut down in the meantime). A skipped run does not drain —
    // the next edit schedules again.
    if (queued && !isShutdown && !skipped) {
      queued = false;
      inflightPromise = runReindex(waitMs);
    }
  }

  // Start a run, coalescing with any in-flight run. A second caller (e.g. a
  // manual /colgrep-reindex firing during a backgrounded startup index) joins
  // the in-flight promise instead of launching a second `colgrep init`.
  // `runReindex()` sets `inFlight` synchronously before its first await, so the
  // guard is race-free against another synchronous caller.
  function startRun(waitMs?: number): Promise<void> {
    if (inFlight && inflightPromise !== undefined) {
      return inflightPromise;
    }
    inflightPromise = runReindex(waitMs);
    return inflightPromise;
  }

  return {
    runNow(options?: { waitMs?: number }): Promise<void> {
      return startRun(options?.waitMs);
    },
    whenIdle(): Promise<void> {
      return inflightPromise ?? Promise.resolve();
    },
    schedule(): void {
      if (isShutdown) return;

      // While a reindex is in flight, mark a queued follow-up instead of
      // starting another debounce timer.
      if (inFlight) {
        if (!queued) {
          queued = true;
          onStatus(QUEUED_STATUS);
        }
        return;
      }
      if (debounceTimer !== undefined) {
        clearTimeout(debounceTimer);
      }
      debounceTimer = setTimeout(() => {
        debounceTimer = undefined;
        inflightPromise = runReindex();
      }, debounceMs);
    },
    async shutdown(): Promise<void> {
      isShutdown = true;
      if (debounceTimer !== undefined) {
        clearTimeout(debounceTimer);
        debounceTimer = undefined;
      }
      if (inflightPromise !== undefined) {
        await inflightPromise;
      }
    },
  };
}
