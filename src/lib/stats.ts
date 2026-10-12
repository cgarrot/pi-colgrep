/**
 * Adoption metrics for the colgrep-first policy.
 *
 * Append-only JSONL at `<agentDir>/extensions/pi-colgrep/stats.jsonl`, so
 * concurrent Pi sessions (mesh, subagents) never race on a
 * read-modify-write cycle. One line per event:
 *
 *   {"ts":"2026-10-12T18:30:00.000Z","event":"search"}
 *
 * Events:
 * - `search`       — a successful `colgrep` tool call
 * - `agent_run`    — a successful `colgrep_agent` run
 * - `grep_blocked` — a recursive in-repo bash search blocked by the guard
 * - `grep_allowed` — a recursive in-repo bash search allowed (guard off,
 *                    warn/anti-loop pass-through)
 *
 * Metrics must never break a session: every file operation is best-effort.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

export type StatEvent =
  | "search"
  | "agent_run"
  | "grep_blocked"
  | "grep_allowed";

export const STAT_EVENTS: StatEvent[] = [
  "search",
  "agent_run",
  "grep_blocked",
  "grep_allowed",
];

export interface StatEntry {
  ts: number;
  event: StatEvent;
}

export interface StatsSummary {
  /** ISO timestamp of the first recorded event, when any. */
  since?: string;
  totals: Record<StatEvent, number>;
  last7Days: Record<StatEvent, number>;
  eventsTotal: number;
  /** Blocked + allowed recursive greps. */
  recursiveGreps: number;
  /** searches / (searches + recursive greps); 1 when no data. */
  colgrepShare: number;
}

export function getStatsPath(agentDir: string): string {
  return join(agentDir, "extensions", "pi-colgrep", "stats.jsonl");
}

/** Append one event. Never throws. */
export function recordStat(
  file: string,
  event: StatEvent,
  now: Date = new Date(),
): void {
  try {
    mkdirSync(dirname(file), { recursive: true });
    appendFileSync(file, `${JSON.stringify({ ts: now.toISOString(), event })}\n`);
  } catch {
    // Best-effort only.
  }
}

/** Read and validate entries; malformed lines are skipped. */
export function readStats(file: string): StatEntry[] {
  if (!existsSync(file)) return [];
  let raw: string;
  try {
    raw = readFileSync(file, "utf-8");
  } catch {
    return [];
  }

  const entries: StatEntry[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    try {
      const parsed = JSON.parse(trimmed) as { ts?: unknown; event?: unknown };
      if (
        typeof parsed.event !== "string" ||
        !STAT_EVENTS.includes(parsed.event as StatEvent)
      ) {
        continue;
      }
      const ts =
        typeof parsed.ts === "string" ? Date.parse(parsed.ts) : Number.NaN;
      entries.push({
        ts: Number.isFinite(ts) ? ts : 0,
        event: parsed.event as StatEvent,
      });
    } catch {
      // Skip malformed lines.
    }
  }
  return entries;
}

export function summarizeStats(
  file: string,
  now: Date = new Date(),
): StatsSummary {
  const entries = readStats(file);
  const totals = zeroCounts();
  const last7Days = zeroCounts();
  const weekAgo = now.getTime() - 7 * 24 * 60 * 60 * 1000;

  let earliest = Number.POSITIVE_INFINITY;
  for (const entry of entries) {
    totals[entry.event] += 1;
    if (entry.ts >= weekAgo) last7Days[entry.event] += 1;
    if (entry.ts > 0 && entry.ts < earliest) earliest = entry.ts;
  }

  const recursiveGreps = totals.grep_blocked + totals.grep_allowed;
  const denominator = totals.search + recursiveGreps;
  return {
    ...(Number.isFinite(earliest)
      ? { since: new Date(earliest).toISOString() }
      : {}),
    totals,
    last7Days,
    eventsTotal: entries.length,
    recursiveGreps,
    colgrepShare: denominator > 0 ? totals.search / denominator : 1,
  };
}

/** Multi-line text for the `/colgrep-stats` command. */
export function formatStatsSummary(summary: StatsSummary): string {
  if (summary.eventsTotal === 0) {
    return "No colgrep usage recorded yet.";
  }
  const since = summary.since ? ` (since ${summary.since.slice(0, 10)})` : "";
  const pct = Math.round(summary.colgrepShare * 100);
  return [
    `ColGrep adoption${since}:`,
    `  colgrep searches:   ${summary.totals.search}  (7d: ${summary.last7Days.search})`,
    `  colgrep_agent runs: ${summary.totals.agent_run}  (7d: ${summary.last7Days.agent_run})`,
    `  recursive greps:    ${summary.recursiveGreps}  (blocked ${summary.totals.grep_blocked}, allowed ${summary.totals.grep_allowed})`,
    `  colgrep share:      ${pct}%`,
  ].join("\n");
}

function zeroCounts(): Record<StatEvent, number> {
  return { search: 0, agent_run: 0, grep_blocked: 0, grep_allowed: 0 };
}
