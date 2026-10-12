import type { Mock } from "vitest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Exec } from "#src/lib/exec";
import { createReindexer } from "#src/lib/reindex";

// ---- shared factory ----

function makeExec(): Mock<Exec> {
  return vi.fn<Exec>();
}

function makeOnStatus(): Mock<(status: string | undefined) => void> {
  return vi.fn<(status: string | undefined) => void>();
}

// ---- Cycle 1: basic reindex execution ----

describe("createReindexer — runNow()", () => {
  let exec: Mock<Exec>;
  let onStatus: Mock<(status: string | undefined) => void>;

  beforeEach(() => {
    exec = makeExec();
    onStatus = makeOnStatus();
  });

  it("calls colgrep init -y . with configured cwd and default timeout", async () => {
    exec.mockResolvedValue({ stdout: "", stderr: "", code: 0 });
    const reindexer = createReindexer({ exec, cwd: "/project", onStatus });
    await reindexer.runNow();
    expect(exec).toHaveBeenCalledWith("colgrep", ["init", "-y", "."], {
      cwd: "/project",
      timeout: 300_000,
    });
  });

  it("respects a custom timeoutMs", async () => {
    exec.mockResolvedValue({ stdout: "", stderr: "", code: 0 });
    const reindexer = createReindexer({
      exec,
      cwd: "/project",
      onStatus,
      timeoutMs: 60_000,
    });
    await reindexer.runNow();
    expect(exec).toHaveBeenCalledWith("colgrep", ["init", "-y", "."], {
      cwd: "/project",
      timeout: 60_000,
    });
  });

  it("calls onStatus with indexing text before exec runs", async () => {
    let statusAtExecTime: string | undefined = "not set";
    exec.mockImplementation(async () => {
      // Capture the most recent onStatus call at the moment exec fires
      statusAtExecTime = onStatus.mock.calls.at(-1)?.[0];
      return { stdout: "", stderr: "", code: 0 };
    });
    const reindexer = createReindexer({ exec, cwd: "/project", onStatus });
    await reindexer.runNow();
    expect(statusAtExecTime).toBe("colgrep: indexing\u2026");
  });

  it("clears status with undefined after successful run", async () => {
    exec.mockResolvedValue({ stdout: "", stderr: "", code: 0 });
    const reindexer = createReindexer({ exec, cwd: "/project", onStatus });
    await reindexer.runNow();
    expect(onStatus).toHaveBeenLastCalledWith(undefined);
  });

  it("resolves without throwing on success", async () => {
    exec.mockResolvedValue({ stdout: "", stderr: "", code: 0 });
    const reindexer = createReindexer({ exec, cwd: "/project", onStatus });
    await expect(reindexer.runNow()).resolves.toBeUndefined();
  });
});

// ---- Cycle 2: error handling ----

describe("createReindexer — runNow() error handling", () => {
  let exec: Mock<Exec>;
  let onStatus: Mock<(status: string | undefined) => void>;

  beforeEach(() => {
    exec = makeExec();
    onStatus = makeOnStatus();
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("shows indexing-failed status when exec exits non-zero", async () => {
    exec.mockResolvedValue({ stdout: "", stderr: "disk full", code: 1 });
    const reindexer = createReindexer({ exec, cwd: "/project", onStatus });
    await reindexer.runNow();
    const statusCalls = onStatus.mock.calls.map((c) => c[0]);
    expect(statusCalls).toContain("colgrep: indexing failed");
  });

  it("clears failed status after a brief delay (undefined follows failed)", async () => {
    exec.mockResolvedValue({ stdout: "", stderr: "disk full", code: 1 });
    const reindexer = createReindexer({ exec, cwd: "/project", onStatus });
    await reindexer.runNow();
    // The last call must clear the status
    expect(onStatus).toHaveBeenLastCalledWith(undefined);
  });

  it("shows indexing-failed status when exec throws", async () => {
    exec.mockRejectedValue(new Error("EPERM"));
    const reindexer = createReindexer({ exec, cwd: "/project", onStatus });
    await reindexer.runNow();
    const statusCalls = onStatus.mock.calls.map((c) => c[0]);
    expect(statusCalls).toContain("colgrep: indexing failed");
  });

  it("resolves without throwing when exec exits non-zero", async () => {
    exec.mockResolvedValue({ stdout: "", stderr: "oops", code: 1 });
    const reindexer = createReindexer({ exec, cwd: "/project", onStatus });
    await expect(reindexer.runNow()).resolves.toBeUndefined();
  });

  it("resolves without throwing when exec throws", async () => {
    exec.mockRejectedValue(new Error("EPERM"));
    const reindexer = createReindexer({ exec, cwd: "/project", onStatus });
    await expect(reindexer.runNow()).resolves.toBeUndefined();
  });

  it("logs the error to console.error", async () => {
    exec.mockRejectedValue(new Error("EPERM"));
    const reindexer = createReindexer({ exec, cwd: "/project", onStatus });
    await reindexer.runNow();
    expect(console.error).toHaveBeenCalled();
  });
});

// ---- Cycle 3: debounced scheduling ----

describe("createReindexer — schedule()", () => {
  let exec: Mock<Exec>;
  let onStatus: Mock<(status: string | undefined) => void>;

  beforeEach(() => {
    exec = makeExec();
    onStatus = makeOnStatus();
    exec.mockResolvedValue({ stdout: "", stderr: "", code: 0 });
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("does not run exec immediately after schedule()", () => {
    const reindexer = createReindexer({
      exec,
      cwd: "/project",
      onStatus,
      debounceMs: 100,
    });
    reindexer.schedule();
    expect(exec).not.toHaveBeenCalled();
  });

  it("runs exec once after the debounce period elapses", async () => {
    const reindexer = createReindexer({
      exec,
      cwd: "/project",
      onStatus,
      debounceMs: 100,
    });
    reindexer.schedule();
    await vi.advanceTimersByTimeAsync(100);
    expect(exec).toHaveBeenCalledTimes(1);
    expect(exec).toHaveBeenCalledWith("colgrep", ["init", "-y", "."], {
      cwd: "/project",
      timeout: 300_000,
    });
  });

  it("resets the timer when schedule() is called again before debounce fires", async () => {
    const reindexer = createReindexer({
      exec,
      cwd: "/project",
      onStatus,
      debounceMs: 100,
    });
    reindexer.schedule();
    await vi.advanceTimersByTimeAsync(80);
    reindexer.schedule(); // reset
    await vi.advanceTimersByTimeAsync(80);
    // still within second debounce window
    expect(exec).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(20);
    expect(exec).toHaveBeenCalledTimes(1);
  });

  it("runs exec only once for rapid repeated schedule() calls", async () => {
    const reindexer = createReindexer({
      exec,
      cwd: "/project",
      onStatus,
      debounceMs: 100,
    });
    reindexer.schedule();
    reindexer.schedule();
    reindexer.schedule();
    await vi.advanceTimersByTimeAsync(100);
    expect(exec).toHaveBeenCalledTimes(1);
  });

  it("calls onStatus with indexing text when scheduled reindex fires", async () => {
    const reindexer = createReindexer({
      exec,
      cwd: "/project",
      onStatus,
      debounceMs: 100,
    });
    reindexer.schedule();
    await vi.advanceTimersByTimeAsync(100);
    expect(onStatus).toHaveBeenCalledWith("colgrep: indexing\u2026");
    expect(onStatus).toHaveBeenLastCalledWith(undefined);
  });

  it("uses the default 4 000 ms debounce when debounceMs is not specified", async () => {
    const reindexer = createReindexer({ exec, cwd: "/project", onStatus });
    reindexer.schedule();
    await vi.advanceTimersByTimeAsync(3_999);
    expect(exec).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(exec).toHaveBeenCalledTimes(1);
  });
});

// ---- Cycle 4: in-flight queuing ----

describe("createReindexer — schedule() in-flight queuing", () => {
  let exec: Mock<Exec>;
  let onStatus: Mock<(status: string | undefined) => void>;
  // resolve controls: lets us hold an in-flight exec until we choose
  let resolveExec: (() => void) | undefined;

  beforeEach(() => {
    exec = makeExec();
    onStatus = makeOnStatus();
    vi.useFakeTimers();
  });

  afterEach(() => {
    resolveExec?.();
    vi.useRealTimers();
  });

  function makeHeldExec(): Mock<Exec> {
    const held = vi.fn<Exec>();
    held.mockImplementation(
      () =>
        new Promise<{ stdout: string; stderr: string; code: number }>(
          (resolve) => {
            resolveExec = () => resolve({ stdout: "", stderr: "", code: 0 });
          },
        ),
    );
    return held;
  }

  it("does not run a second exec concurrently while one is in-flight", async () => {
    exec = makeHeldExec();
    const reindexer = createReindexer({
      exec,
      cwd: "/project",
      onStatus,
      debounceMs: 10,
    });
    // Start first reindex
    reindexer.schedule();
    await vi.advanceTimersByTimeAsync(10);
    // First exec is in flight; schedule another
    reindexer.schedule();
    await vi.advanceTimersByTimeAsync(10);
    // Second exec must NOT have started yet
    expect(exec).toHaveBeenCalledTimes(1);
    // Finish first
    resolveExec?.();
    resolveExec = undefined as (() => void) | undefined;
    await vi.advanceTimersByTimeAsync(0);
    // Now second should run
    expect(exec).toHaveBeenCalledTimes(2);
    // clean up second held exec
    resolveExec?.();
    resolveExec = undefined as (() => void) | undefined;
    await vi.advanceTimersByTimeAsync(0);
  });

  it("runs the queued reindex after the in-flight one finishes", async () => {
    exec = makeHeldExec();
    const reindexer = createReindexer({
      exec,
      cwd: "/project",
      onStatus,
      debounceMs: 10,
    });
    reindexer.schedule();
    await vi.advanceTimersByTimeAsync(10);
    reindexer.schedule();
    // Finish first
    resolveExec?.();
    resolveExec = undefined as (() => void) | undefined;
    await vi.advanceTimersByTimeAsync(0);
    expect(exec).toHaveBeenCalledTimes(2);
    resolveExec?.();
    resolveExec = undefined as (() => void) | undefined;
    await vi.advanceTimersByTimeAsync(0);
  });

  it("collapses multiple schedule() calls while in-flight into a single queued run", async () => {
    exec = makeHeldExec();
    const reindexer = createReindexer({
      exec,
      cwd: "/project",
      onStatus,
      debounceMs: 10,
    });
    reindexer.schedule();
    await vi.advanceTimersByTimeAsync(10);
    // Three more calls while in-flight
    reindexer.schedule();
    reindexer.schedule();
    reindexer.schedule();
    resolveExec?.();
    resolveExec = undefined as (() => void) | undefined;
    await vi.advanceTimersByTimeAsync(0);
    // Only one additional run (the queued one)
    expect(exec).toHaveBeenCalledTimes(2);
    resolveExec?.();
    resolveExec = undefined as (() => void) | undefined;
    await vi.advanceTimersByTimeAsync(0);
  });

  it("shows queued-updates status when schedule() is called while in-flight", async () => {
    exec = makeHeldExec();
    const reindexer = createReindexer({
      exec,
      cwd: "/project",
      onStatus,
      debounceMs: 10,
    });
    reindexer.schedule();
    await vi.advanceTimersByTimeAsync(10);
    reindexer.schedule(); // queue
    expect(onStatus).toHaveBeenCalledWith(
      "colgrep: indexing\u2026 (queued updates)",
    );
    resolveExec?.();
    resolveExec = undefined as (() => void) | undefined;
    await vi.advanceTimersByTimeAsync(0);
    resolveExec?.();
    resolveExec = undefined as (() => void) | undefined;
    await vi.advanceTimersByTimeAsync(0);
  });
});

// ---- Cycle 5: shutdown ----

describe("createReindexer — shutdown()", () => {
  let exec: Mock<Exec>;
  let onStatus: Mock<(status: string | undefined) => void>;
  let resolveExecShutdown: (() => void) | undefined;

  beforeEach(() => {
    exec = makeExec();
    onStatus = makeOnStatus();
    vi.useFakeTimers();
  });

  afterEach(() => {
    resolveExecShutdown?.();
    vi.useRealTimers();
  });

  it("cancels a pending debounce timer so no reindex fires afterward", async () => {
    exec.mockResolvedValue({ stdout: "", stderr: "", code: 0 });
    const reindexer = createReindexer({
      exec,
      cwd: "/project",
      onStatus,
      debounceMs: 100,
    });
    reindexer.schedule();
    await reindexer.shutdown();
    await vi.advanceTimersByTimeAsync(200);
    expect(exec).not.toHaveBeenCalled();
  });

  it("waits for an in-flight reindex before resolving", async () => {
    const held = vi.fn<Exec>();
    held.mockImplementation(
      () =>
        new Promise<{ stdout: string; stderr: string; code: number }>(
          (resolve) => {
            resolveExecShutdown = () =>
              resolve({ stdout: "", stderr: "", code: 0 });
          },
        ),
    );
    const reindexer = createReindexer({
      exec: held,
      cwd: "/project",
      onStatus,
      debounceMs: 10,
    });
    reindexer.schedule();
    await vi.advanceTimersByTimeAsync(10); // fire debounce, starts reindex
    let shutdownDone = false;
    const shutdownPromise = reindexer.shutdown().then(() => {
      shutdownDone = true;
    });
    // shutdown should not be done while exec is still in-flight
    await vi.advanceTimersByTimeAsync(0);
    expect(shutdownDone).toBe(false);
    // finish exec
    resolveExecShutdown?.();
    resolveExecShutdown = undefined;
    await shutdownPromise;
    expect(shutdownDone).toBe(true);
  });

  it("makes schedule() a no-op after shutdown", async () => {
    exec.mockResolvedValue({ stdout: "", stderr: "", code: 0 });
    const reindexer = createReindexer({
      exec,
      cwd: "/project",
      onStatus,
      debounceMs: 100,
    });
    await reindexer.shutdown();
    reindexer.schedule();
    await vi.advanceTimersByTimeAsync(200);
    expect(exec).not.toHaveBeenCalled();
  });
});

// ---- Issue #389: runNow() coalescing & in-flight tracking ----

describe("createReindexer — runNow() coalescing & in-flight tracking", () => {
  let onStatus: Mock<(status: string | undefined) => void>;
  let resolveHeld: (() => void) | undefined;

  beforeEach(() => {
    onStatus = makeOnStatus();
  });

  afterEach(() => {
    resolveHeld?.();
    resolveHeld = undefined;
  });

  function makeHeldExec(): Mock<Exec> {
    const held = vi.fn<Exec>();
    held.mockImplementation(
      () =>
        new Promise<{ stdout: string; stderr: string; code: number }>(
          (resolve) => {
            resolveHeld = () => resolve({ stdout: "", stderr: "", code: 0 });
          },
        ),
    );
    return held;
  }

  it("coalesces concurrent runNow() calls into a single colgrep init", async () => {
    const exec = makeHeldExec();
    const reindexer = createReindexer({ exec, cwd: "/project", onStatus });
    const first = reindexer.runNow();
    const second = reindexer.runNow();
    // The second call must join the in-flight run, not start a second init.
    expect(exec).toHaveBeenCalledTimes(1);
    resolveHeld?.();
    resolveHeld = undefined;
    await Promise.all([first, second]);
    expect(exec).toHaveBeenCalledTimes(1);
  });

  it("shutdown() awaits a fire-and-forget runNow()", async () => {
    const exec = makeHeldExec();
    const reindexer = createReindexer({ exec, cwd: "/project", onStatus });
    // Fire and forget — do not await the startup index.
    void reindexer.runNow();
    expect(exec).toHaveBeenCalledTimes(1);
    let shutdownDone = false;
    const shutdownPromise = reindexer.shutdown().then(() => {
      shutdownDone = true;
    });
    // shutdown must still be pending while the backgrounded run is in flight.
    await Promise.resolve();
    expect(shutdownDone).toBe(false);
    resolveHeld?.();
    resolveHeld = undefined;
    await shutdownPromise;
    expect(shutdownDone).toBe(true);
  });
});
