/**
 * Tool-call timer for the colgrep tools.
 *
 * Mirrors Pi's built-in timing line: `Elapsed 4.2s` while a call is still
 * running (the row is redrawn once per second so the value keeps counting up)
 * and `Took 4.2s` once the result is final.
 *
 * Pi keeps those helpers in `core/tools/render-utils.ts`
 * (`startToolTimer` / `toolTimerText` / `formatToolDuration`) but does not
 * export them from the package root, so they are re-implemented here with the
 * same semantics:
 *
 * - the clock starts when the tool execution starts (`startToolTimer`);
 * - `toolTimerText(context, true)` returns the live `Elapsed <d>` and arms a
 *   one-second ticker that redraws the row;
 * - `toolTimerText(context, false)` returns the final `Took <d>`, prefers the
 *   duration Pi recorded for the execution (`context.durationMs`) and stops
 *   the ticker.
 */

/** Per-row timer state, kept in Pi's shared renderer state. */
export interface ToolTimerState {
  /** Epoch ms at which the tool execution started. */
  startedAt?: number;
  /** Epoch ms at which the tool execution finished. */
  endedAt?: number;
  /** Ticker that redraws the row while the call runs. */
  interval?: ReturnType<typeof setInterval>;
}

/** The subset of Pi's `ToolRenderContext` the timer needs. */
export interface ToolTimerContext {
  /** Pi's per-row renderer state, shared across the renders of one call. */
  state: ToolTimerState;
  /** Redraw this tool row. */
  invalidate: () => void;
  /** Whether the tool execution has started. */
  executionStarted: boolean;
  /** Whether the result is a partial (streaming) one. */
  isPartial?: boolean;
  /** Whether the current result is an error. */
  isError?: boolean;
  /** Duration Pi recorded for the finished execution. */
  durationMs?: number;
}

/** Redraw period of the live counter. */
const TICK_MS = 1000;

/** Duration as `4.2s` below a minute, then `1m 30s` and `2h 3m 4s`. */
export function formatToolDuration(ms: number): string {
  const seconds = Math.max(0, ms) / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const totalSeconds = Math.floor(seconds);
  const minutes = Math.floor(totalSeconds / 60);
  const remainder = totalSeconds % 60;
  if (minutes < 60) return `${minutes}m ${remainder}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m ${remainder}s`;
}

/** Start the row's clock once the execution starts. Call from `renderCall`. */
export function startToolTimer(context: ToolTimerContext): void {
  const state = context.state;
  if (context.executionStarted && state.startedAt === undefined) {
    state.startedAt = Date.now();
    state.endedAt = undefined;
  }
}

/**
 * The row's timing line: `Elapsed 4.2s` while the call is running (the row is
 * redrawn every second) and `Took 4.2s` once it is final. `undefined` when the
 * row has no start time and no recorded duration.
 */
export function toolTimerText(
  context: ToolTimerContext,
  isPartial: boolean,
): string | undefined {
  const state = context.state;

  // Live counter: redraw the row once per second so "Elapsed" keeps counting.
  if (state.startedAt !== undefined && isPartial && !state.interval) {
    state.interval = setInterval(() => context.invalidate(), TICK_MS);
  }

  // The call is over: stop the ticker and freeze the end time.
  if (!isPartial || context.isError) {
    state.endedAt ??= Date.now();
    if (state.interval) {
      clearInterval(state.interval);
      state.interval = undefined;
    }
  }

  // A final result's recorded duration wins: it is monotonic and survives
  // reloads. The renderer's own clock is the fallback for live progress and
  // for results stored without one.
  if (!isPartial && context.durationMs !== undefined) {
    return `Took ${formatToolDuration(context.durationMs)}`;
  }
  if (state.startedAt === undefined) return undefined;
  const endTime = state.endedAt ?? Date.now();
  return `${isPartial ? "Elapsed" : "Took"} ${formatToolDuration(endTime - state.startedAt)}`;
}

/**
 * The live `Elapsed <d>` shown while a call is still running.
 *
 * `undefined` once the call is final (the result block then carries the
 * `Took <d>` line) or before the execution started.
 */
export function runningTimerText(
  context: ToolTimerContext,
): string | undefined {
  if (context.isPartial === false) return undefined;
  return toolTimerText(context, true);
}
