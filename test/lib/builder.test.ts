import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import {
  cleanPtyOutput,
  parseBuildProgress,
  runIndexBuild,
} from "#src/lib/builder";

describe("cleanPtyOutput", () => {
  it("strips ANSI sequences and converts CR rewrites to newlines", () => {
    const raw =
      "\u001b[2K\u001b[32m\u2804\u001b[0m [\u2591\u2591] 3/10\r\u001b[2K[\u2588\u2588] 7/10";
    const cleaned = cleanPtyOutput(raw);
    expect(cleaned).not.toContain("\u001b");
    expect(cleaned).toContain("7/10");
  });
});

describe("parseBuildProgress", () => {
  it("takes the last progress pair", () => {
    expect(parseBuildProgress("0/1500\r\n5/1500\r\n42/1500")).toEqual({
      current: 42,
      total: 1500,
      percent: 3,
    });
  });

  it("handles comma separators and ANSI sequences", () => {
    const progress = parseBuildProgress(
      "\u001b[2K\u2804 [\u2588\u2588] 12,345/29,191",
    );
    expect(progress).toEqual({
      current: 12_345,
      total: 29_191,
      percent: 42,
    });
  });

  it("returns undefined when nothing matches", () => {
    expect(parseBuildProgress("Indexed /p (added: 3)")).toBeUndefined();
  });

  it("ignores implausible totals", () => {
    expect(parseBuildProgress("5/0")).toBeUndefined();
  });
});

interface FakeChild extends EventEmitter {
  stdout: EventEmitter;
  stderr: EventEmitter;
  kill: ReturnType<typeof vi.fn>;
}

function fakeChild(): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = vi.fn();
  return child;
}

describe("runIndexBuild", () => {
  it("collects stdout/stderr without a PTY", async () => {
    const child = fakeChild();
    const spawnFn = vi.fn(() => child);
    const promise = runIndexBuild({
      cwd: "/p",
      args: ["init", "-y", "."],
      timeoutMs: 5_000,
      logPath: "/tmp/pi-colgrep-test.log",
      usePty: false,
      spawnFn: spawnFn as never,
    });
    child.stdout.emit("data", Buffer.from("hello\n"));
    child.stderr.emit("data", Buffer.from("warn\n"));
    child.emit("close", 0);

    await expect(promise).resolves.toEqual({
      code: 0,
      stdout: "hello\n",
      stderr: "warn\n",
    });
    expect(spawnFn).toHaveBeenCalledWith(
      "colgrep",
      ["init", "-y", "."],
      expect.objectContaining({ cwd: "/p" }),
    );
  });

  it("kills the child after the timeout", async () => {
    vi.useFakeTimers();
    try {
      const child = fakeChild();
      const promise = runIndexBuild({
        cwd: "/p",
        args: ["init"],
        timeoutMs: 1_000,
        logPath: "/tmp/pi-colgrep-test.log",
        usePty: false,
        spawnFn: (() => child) as never,
      });

      await vi.advanceTimersByTimeAsync(1_000);
      expect(child.kill).toHaveBeenCalledWith("SIGTERM");
      await vi.advanceTimersByTimeAsync(3_000);
      expect(child.kill).toHaveBeenCalledWith("SIGKILL");

      child.emit("close", null);
      await promise;
    } finally {
      vi.useRealTimers();
    }
  });
});
