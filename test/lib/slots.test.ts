import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createSlotLimiter, createSlotRunner } from "#src/lib/slots";

const cleanups: string[] = [];

function tmpDir(): string {
  const dir = join(tmpdir(), `pi-colgrep-slots-${Date.now()}-${Math.random()}`);
  mkdirSync(dir, { recursive: true });
  cleanups.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of cleanups) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {}
  }
  cleanups.length = 0;
});

/** Fake clock whose `sleep` advances time, so wait loops terminate. */
function fakeClock(start = 0): {
  now: () => number;
  sleep: (ms: number) => Promise<void>;
} {
  let current = start;
  return {
    now: () => current,
    sleep: async (ms: number) => {
      current += ms;
    },
  };
}

const alwaysAlive = () => true;
const neverAlive = () => false;

describe("createSlotLimiter", () => {
  it("acquires up to max slots, then times out", async () => {
    const clock = fakeClock();
    const limiter = createSlotLimiter({
      dir: tmpDir(),
      name: "s",
      max: () => 2,
      isProcessAlive: alwaysAlive,
      ...clock,
    });
    expect(await limiter.acquire(1_000)).toBeDefined();
    expect(await limiter.acquire(1_000)).toBeDefined();
    expect(await limiter.acquire(1_000)).toBeUndefined();
  });

  it("frees slots on release", async () => {
    const clock = fakeClock();
    const limiter = createSlotLimiter({
      dir: tmpDir(),
      name: "s",
      max: () => 1,
      isProcessAlive: alwaysAlive,
      ...clock,
    });
    const handle = await limiter.acquire(0);
    expect(handle).toBeDefined();
    expect(await limiter.acquire(0)).toBeUndefined();
    handle?.release();
    expect(await limiter.acquire(0)).toBeDefined();
  });

  it("steals a lock whose owner process is dead", async () => {
    const dir = tmpDir();
    writeFileSync(
      join(dir, "s.0.lock"),
      JSON.stringify({ pid: 999_999, id: "dead", ts: 1_000 }),
    );
    const limiter = createSlotLimiter({
      dir,
      name: "s",
      max: () => 1,
      isProcessAlive: neverAlive,
      now: () => 1_000,
      sleep: async () => {},
    });
    expect(await limiter.acquire(0)).toBeDefined();
  });

  it("steals a lock older than staleMs", async () => {
    const dir = tmpDir();
    writeFileSync(
      join(dir, "s.0.lock"),
      JSON.stringify({ pid: 4242, id: "old", ts: 0 }),
    );
    const limiter = createSlotLimiter({
      dir,
      name: "s",
      max: () => 1,
      isProcessAlive: alwaysAlive,
      now: () => 10_000_000,
      staleMs: 1_000,
      sleep: async () => {},
    });
    expect(await limiter.acquire(0)).toBeDefined();
  });

  it("does not steal a live, fresh lock", async () => {
    const dir = tmpDir();
    writeFileSync(
      join(dir, "s.0.lock"),
      JSON.stringify({ pid: 4242, id: "live", ts: 500 }),
    );
    const limiter = createSlotLimiter({
      dir,
      name: "s",
      max: () => 1,
      isProcessAlive: alwaysAlive,
      now: () => 1_000,
      staleMs: 10_000,
      sleep: async () => {},
    });
    expect(await limiter.acquire(0)).toBeUndefined();
  });

  it("creates the lock directory on demand", async () => {
    const dir = join(tmpDir(), "nested", "slots");
    const limiter = createSlotLimiter({
      dir,
      name: "s",
      max: () => 1,
      isProcessAlive: alwaysAlive,
      now: () => 0,
      sleep: async () => {},
    });
    expect(await limiter.acquire(0)).toBeDefined();
    expect(existsSync(join(dir, "s.0.lock"))).toBe(true);
  });
});

describe("createSlotRunner", () => {
  it("runs the operation while holding a slot, then releases it", async () => {
    const clock = fakeClock();
    const limiter = createSlotLimiter({
      dir: tmpDir(),
      name: "s",
      max: () => 1,
      isProcessAlive: alwaysAlive,
      ...clock,
    });
    const runner = createSlotRunner(limiter, () => 0);
    await expect(runner(async () => 42)).resolves.toBe(42);
    // The slot is free again after the run.
    expect(await limiter.acquire(0)).toBeDefined();
  });

  it("resolves undefined when no slot is available", async () => {
    const clock = fakeClock();
    const limiter = createSlotLimiter({
      dir: tmpDir(),
      name: "s",
      max: () => 1,
      isProcessAlive: alwaysAlive,
      ...clock,
    });
    const held = await limiter.acquire(0);
    expect(held).toBeDefined();
    const runner = createSlotRunner(limiter, () => 0);
    await expect(runner(async () => 1)).resolves.toBeUndefined();
  });
});
