import { afterEach, describe, expect, it, vi } from "vitest";
import {
  formatToolDuration,
  runningTimerText,
  startToolTimer,
  toolTimerText,
  type ToolTimerContext,
} from "#src/lib/timer";

function makeContext(
  overrides: Partial<ToolTimerContext> = {},
): ToolTimerContext {
  return {
    state: {},
    invalidate: vi.fn(),
    executionStarted: false,
    ...overrides,
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("formatToolDuration", () => {
  it("formats sub-minute durations with one decimal", () => {
    expect(formatToolDuration(0)).toBe("0.0s");
    expect(formatToolDuration(4200)).toBe("4.2s");
    expect(formatToolDuration(59_900)).toBe("59.9s");
  });

  it("formats minutes", () => {
    expect(formatToolDuration(60_000)).toBe("1m 0s");
    expect(formatToolDuration(90_000)).toBe("1m 30s");
    expect(formatToolDuration(3_599_000)).toBe("59m 59s");
  });

  it("formats hours", () => {
    expect(formatToolDuration(3_600_000)).toBe("1h 0m 0s");
    expect(formatToolDuration(3_723_000)).toBe("1h 2m 3s");
  });

  it("never renders a negative duration", () => {
    expect(formatToolDuration(-500)).toBe("0.0s");
  });
});

describe("startToolTimer", () => {
  it("does not start the clock before the execution starts", () => {
    const context = makeContext();
    startToolTimer(context);
    expect(context.state.startedAt).toBeUndefined();
  });

  it("starts the clock once the execution starts", () => {
    vi.useFakeTimers();
    const context = makeContext({ executionStarted: true });
    startToolTimer(context);
    expect(context.state.startedAt).toBe(Date.now());
  });

  it("does not restart the clock on later renders", () => {
    vi.useFakeTimers();
    const context = makeContext({ executionStarted: true });
    startToolTimer(context);
    const first = context.state.startedAt;
    vi.advanceTimersByTime(5_000);
    startToolTimer(context);
    expect(context.state.startedAt).toBe(first);
  });
});

describe("toolTimerText", () => {
  it("returns undefined when the row never started and has no duration", () => {
    const context = makeContext();
    expect(toolTimerText(context, false)).toBeUndefined();
  });

  it("returns the live elapsed time while the call runs", () => {
    vi.useFakeTimers();
    const context = makeContext({ executionStarted: true });
    startToolTimer(context);
    expect(toolTimerText(context, true)).toBe("Elapsed 0.0s");
    vi.advanceTimersByTime(1500);
    expect(toolTimerText(context, true)).toBe("Elapsed 1.5s");
  });

  it("redraws the row once per second while the call runs", () => {
    vi.useFakeTimers();
    const context = makeContext({ executionStarted: true });
    startToolTimer(context);
    toolTimerText(context, true);
    expect(context.invalidate).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1000);
    expect(context.invalidate).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(2000);
    expect(context.invalidate).toHaveBeenCalledTimes(3);
  });

  it("reports the total duration once the result is final", () => {
    vi.useFakeTimers();
    const context = makeContext({ executionStarted: true });
    startToolTimer(context);
    toolTimerText(context, true);
    vi.advanceTimersByTime(2500);
    expect(toolTimerText(context, false)).toBe("Took 2.5s");
  });

  it("stops ticking once the result is final", () => {
    vi.useFakeTimers();
    const context = makeContext({ executionStarted: true });
    startToolTimer(context);
    toolTimerText(context, true);
    vi.advanceTimersByTime(1000);
    const before = vi.mocked(context.invalidate).mock.calls.length;
    toolTimerText(context, false);
    vi.advanceTimersByTime(5000);
    expect(vi.mocked(context.invalidate).mock.calls.length).toBe(before);
    expect(context.state.interval).toBeUndefined();
  });

  it("prefers the duration Pi recorded for the execution", () => {
    const context = makeContext({
      executionStarted: true,
      durationMs: 4200,
    });
    startToolTimer(context);
    expect(toolTimerText(context, false)).toBe("Took 4.2s");
  });

  it("stops ticking on an error result", () => {
    vi.useFakeTimers();
    const context = makeContext({ executionStarted: true, isError: true });
    startToolTimer(context);
    toolTimerText(context, true);
    toolTimerText(context, false);
    expect(context.state.interval).toBeUndefined();
    expect(context.state.endedAt).toBeDefined();
  });
});

describe("runningTimerText", () => {
  it("returns the live elapsed time while the call runs", () => {
    vi.useFakeTimers();
    const context = makeContext({ executionStarted: true, isPartial: true });
    startToolTimer(context);
    expect(runningTimerText(context)).toBe("Elapsed 0.0s");
  });

  it("returns undefined once the result is final", () => {
    const context = makeContext({ executionStarted: true, isPartial: false });
    startToolTimer(context);
    expect(runningTimerText(context)).toBeUndefined();
  });

  it("returns undefined before the execution started", () => {
    const context = makeContext({ executionStarted: false });
    expect(runningTimerText(context)).toBeUndefined();
  });
});
