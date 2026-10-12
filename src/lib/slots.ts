/**
 * Cross-process slot limiter for expensive colgrep operations.
 *
 * Pi can run many sessions on one machine (mesh swarms, subagents), each with
 * its own extension instance. Per-session counters cannot protect the machine:
 * a swarm of agents would still launch N parallel colgrep processes. This
 * limiter uses lock files in a shared directory so ALL sessions share one
 * budget for searches, index builds, and agent runs (a 2B model run costs
 * ~4 GB of RAM; several in parallel thrash the machine into swap).
 *
 * Locks are advisory and self-healing: a lock whose owner PID is dead or older
 * than `staleMs` is stolen, so a crashed session can never wedge the machine.
 */
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface SlotHandle {
  release(): void;
}

export interface SlotLimiter {
  /**
   * Try to acquire one of `max()` slots, waiting up to `waitMs`.
   * Returns undefined when no slot became free in time.
   */
  acquire(waitMs: number): Promise<SlotHandle | undefined>;
}

export interface SlotLimiterOptions {
  /** Shared directory for lock files (created on demand). */
  dir: string;
  /** Limiter name, e.g. "search" | "init" | "agent". */
  name: string;
  /** Number of concurrent slots; read at acquire time. */
  max: () => number;
  /** Locks older than this are considered stale and stolen (default 15 min). */
  staleMs?: number;
  /** Poll interval while waiting (default 500 ms). */
  pollMs?: number;
  /** Injectable liveness check (tests). Defaults to `process.kill(pid, 0)`. */
  isProcessAlive?: (pid: number) => boolean;
  /** Injectable clock (tests). */
  now?: () => number;
  /** Injectable sleep (tests). */
  sleep?: (ms: number) => Promise<void>;
}

/** Wraps `fn` in a slot; resolves undefined when no slot was acquired in time. */
export type SlotRunner = <T>(
  fn: () => Promise<T>,
  waitMs?: number,
) => Promise<T | undefined>;

interface LockFile {
  pid: number;
  id: string;
  ts: number;
}

const DEFAULT_STALE_MS = 15 * 60 * 1000;
const DEFAULT_POLL_MS = 500;

export function createSlotLimiter(options: SlotLimiterOptions): SlotLimiter {
  const {
    dir,
    name,
    max,
    staleMs = DEFAULT_STALE_MS,
    pollMs = DEFAULT_POLL_MS,
    isProcessAlive = defaultIsProcessAlive,
    now = Date.now,
    sleep = defaultSleep,
  } = options;

  const id = randomUUID();

  function lockPath(index: number): string {
    return join(dir, `${name}.${index}.lock`);
  }

  function readLock(path: string): LockFile | undefined {
    try {
      const parsed = JSON.parse(readFileSync(path, "utf-8")) as Partial<LockFile>;
      if (
        typeof parsed.pid === "number" &&
        typeof parsed.id === "string" &&
        typeof parsed.ts === "number"
      ) {
        return { pid: parsed.pid, id: parsed.id, ts: parsed.ts };
      }
    } catch {
      // Unreadable/partial lock: fall through to mtime-based staleness.
    }
    return undefined;
  }

  function isStale(path: string, lock: LockFile | undefined): boolean {
    if (lock) {
      if (!isProcessAlive(lock.pid)) return true;
      return now() - lock.ts > staleMs;
    }
    try {
      const mtime = statSync(path).mtimeMs;
      return now() - mtime > staleMs;
    } catch {
      // Vanished between checks: treat as stale so the slot can be retried.
      return true;
    }
  }

  function tryAcquire(index: number): SlotHandle | undefined {
    const path = lockPath(index);
    const payload = JSON.stringify({ pid: process.pid, id, ts: now() });

    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        mkdirSync(dir, { recursive: true });
        writeFileSync(path, payload, { flag: "wx" });
        return {
          release: () => {
            try {
              const current = readLock(path);
              if (current?.id === id) unlinkSync(path);
            } catch {
              // Already gone — nothing to release.
            }
          },
        };
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code !== "EEXIST") return undefined;
        const lock = readLock(path);
        if (!isStale(path, lock)) return undefined;
        // Steal the stale lock, then retry once.
        try {
          unlinkSync(path);
        } catch {
          // Someone else stole it first; the retry will report EEXIST again.
        }
      }
    }
    return undefined;
  }

  return {
    async acquire(waitMs: number): Promise<SlotHandle | undefined> {
      const deadline = now() + Math.max(0, waitMs);
      for (;;) {
        const slots = Math.max(1, Math.floor(max()));
        for (let index = 0; index < slots; index += 1) {
          const handle = tryAcquire(index);
          if (handle) return handle;
        }
        const remaining = deadline - now();
        if (remaining <= 0) return undefined;
        await sleep(Math.min(pollMs, remaining));
      }
    },
  };
}

/**
 * Create a SlotRunner bound to a limiter: wraps an operation so it only runs
 * while holding a slot. Resolves `undefined` when no slot was acquired within
 * `waitMs` (per-call override or the `defaultWaitMs` getter).
 */
export function createSlotRunner(
  limiter: SlotLimiter,
  defaultWaitMs: () => number,
): SlotRunner {
  return async <T>(fn: () => Promise<T>, waitMs?: number) => {
    const handle = await limiter.acquire(waitMs ?? defaultWaitMs());
    if (!handle) return undefined;
    try {
      return await fn();
    } finally {
      handle.release();
    }
  };
}

function defaultIsProcessAlive(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means the process exists but belongs to another user.
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
