import { rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  formatStatsSummary,
  getStatsPath,
  readStats,
  recordStat,
  summarizeStats,
} from "#src/lib/stats";

const cleanups: string[] = [];

function tmpFile(): string {
  const file = join(
    tmpdir(),
    `pi-colgrep-stats-${Date.now()}-${Math.random()}.jsonl`,
  );
  cleanups.push(file);
  return file;
}

afterEach(() => {
  for (const file of cleanups) {
    try {
      rmSync(file, { force: true });
    } catch {}
  }
  cleanups.length = 0;
});

describe("getStatsPath", () => {
  it("builds the extension-scoped path", () => {
    expect(getStatsPath("/home/u/.pi/agent")).toBe(
      "/home/u/.pi/agent/extensions/pi-colgrep/stats.jsonl",
    );
  });
});

describe("recordStat / readStats", () => {
  it("creates the file and appends entries", () => {
    const file = tmpFile();
    recordStat(file, "search", new Date("2026-10-12T10:00:00Z"));
    recordStat(file, "grep_blocked", new Date("2026-10-12T11:00:00Z"));
    expect(readStats(file)).toEqual([
      { ts: Date.parse("2026-10-12T10:00:00Z"), event: "search" },
      { ts: Date.parse("2026-10-12T11:00:00Z"), event: "grep_blocked" },
    ]);
  });

  it("returns [] for a missing file", () => {
    expect(readStats(join(tmpdir(), "pi-colgrep-missing.jsonl"))).toEqual([]);
  });

  it("skips malformed lines and unknown events", () => {
    const file = tmpFile();
    writeFileSync(
      file,
      'not json\n{"ts":"2026-10-12T10:00:00Z","event":"other"}\n' +
        '{"ts":"2026-10-12T10:00:00Z","event":"search"}\n',
    );
    expect(readStats(file)).toEqual([
      { ts: Date.parse("2026-10-12T10:00:00Z"), event: "search" },
    ]);
  });
});

describe("summarizeStats", () => {
  it("aggregates totals, last 7 days, share and since", () => {
    const file = tmpFile();
    const now = new Date("2026-10-12T12:00:00Z");
    recordStat(file, "search", new Date("2026-10-01T10:00:00Z"));
    recordStat(file, "search", new Date("2026-10-11T10:00:00Z"));
    recordStat(file, "agent_run", new Date("2026-10-11T11:00:00Z"));
    recordStat(file, "grep_blocked", new Date("2026-10-11T12:00:00Z"));
    recordStat(file, "grep_allowed", new Date("2026-10-11T13:00:00Z"));

    const summary = summarizeStats(file, now);
    expect(summary.totals).toEqual({
      search: 2,
      agent_run: 1,
      grep_blocked: 1,
      grep_allowed: 1,
    });
    expect(summary.last7Days).toEqual({
      search: 1,
      agent_run: 1,
      grep_blocked: 1,
      grep_allowed: 1,
    });
    expect(summary.recursiveGreps).toBe(2);
    expect(summary.colgrepShare).toBeCloseTo(2 / 4);
    expect(summary.since).toBe(
      new Date("2026-10-01T10:00:00Z").toISOString(),
    );
    expect(summary.eventsTotal).toBe(5);
  });

  it("defaults share to 1 with no data", () => {
    const summary = summarizeStats(join(tmpdir(), "pi-colgrep-missing-2.jsonl"));
    expect(summary.eventsTotal).toBe(0);
    expect(summary.colgrepShare).toBe(1);
  });
});

describe("formatStatsSummary", () => {
  it("renders totals and the colgrep share", () => {
    const text = formatStatsSummary({
      since: "2026-10-01T00:00:00.000Z",
      totals: { search: 10, agent_run: 2, grep_blocked: 3, grep_allowed: 1 },
      last7Days: { search: 5, agent_run: 1, grep_blocked: 2, grep_allowed: 0 },
      eventsTotal: 16,
      recursiveGreps: 4,
      colgrepShare: 10 / 14,
    });
    expect(text).toContain("10");
    expect(text).toContain("recursive greps:    4");
    expect(text).toContain("71%");
  });

  it("handles empty data", () => {
    const text = formatStatsSummary(
      summarizeStats(join(tmpdir(), "pi-colgrep-missing-3.jsonl")),
    );
    expect(text).toContain("No colgrep usage");
  });
});
