import { describe, expect, it } from "vitest";
import { formatHit, formatResults } from "#src/lib/format";

const searchDir = "/project/src";

describe("formatHit", () => {
  it("formats path relative to searchDir", () => {
    const hit = makeHit("/project/src/auth/login.ts", 10, 25, 0.876);
    expect(formatHit(hit, searchDir)).toBe("auth/login.ts:10-25 [score=0.876]");
  });

  it("formats score to 3 decimal places", () => {
    const hit = makeHit("/project/src/foo.ts", 1, 1, 0.1);
    expect(formatHit(hit, searchDir)).toBe("foo.ts:1-1 [score=0.100]");
  });

  it("formats a very small score without scientific notation", () => {
    const hit = makeHit("/project/src/bar.ts", 5, 10, 0.016393442);
    expect(formatHit(hit, searchDir)).toBe("bar.ts:5-10 [score=0.016]");
  });

  it("uses absolute path when file is outside searchDir", () => {
    const hit = makeHit("/other/place/baz.ts", 3, 7, 0.5);
    expect(formatHit(hit, searchDir)).toBe(
      "/other/place/baz.ts:3-7 [score=0.500]",
    );
  });

  it("handles same-directory file (no leading slash in relative path)", () => {
    const hit = makeHit("/project/src/index.ts", 1, 5, 0.9);
    expect(formatHit(hit, searchDir)).toBe("index.ts:1-5 [score=0.900]");
  });
});

describe("formatResults", () => {
  it("returns 'No matches found' for an empty array", () => {
    expect(formatResults("[]", searchDir)).toBe("No matches found");
  });

  it("formats a single hit", () => {
    const json = JSON.stringify([makeHit("/project/src/foo.ts", 1, 3, 0.5)]);
    expect(formatResults(json, searchDir)).toBe("foo.ts:1-3 [score=0.500]");
  });

  it("formats multiple hits separated by newlines", () => {
    const json = JSON.stringify([
      makeHit("/project/src/a.ts", 1, 5, 0.9),
      makeHit("/project/src/b.ts", 10, 20, 0.7),
    ]);
    expect(formatResults(json, searchDir)).toBe(
      "a.ts:1-5 [score=0.900]\nb.ts:10-20 [score=0.700]",
    );
  });

  it("falls back to raw stdout on malformed JSON", () => {
    const raw = "not valid json";
    expect(formatResults(raw, searchDir)).toBe(raw);
  });

  it("falls back to raw stdout when JSON is not an array", () => {
    const raw = JSON.stringify({ error: "something went wrong" });
    expect(formatResults(raw, searchDir)).toBe(raw);
  });

  it("skips hits with missing unit fields rather than throwing", () => {
    const json = JSON.stringify([
      {
        unit: { file: "/project/src/ok.ts", line: 1, end_line: 2 },
        score: 0.5,
      },
      { score: 0.3 }, // malformed — no unit
      {
        unit: { file: "/project/src/also-ok.ts", line: 5, end_line: 6 },
        score: 0.4,
      },
    ]);
    expect(formatResults(json, searchDir)).toBe(
      "ok.ts:1-2 [score=0.500]\nalso-ok.ts:5-6 [score=0.400]",
    );
  });
});

// ---- helpers ----

function makeHit(file: string, line: number, end_line: number, score: number) {
  return {
    unit: {
      name: "testFn",
      qualified_name: `${file}::testFn`,
      file,
      line,
      end_line,
      language: "typescript",
      unit_type: "function",
      signature: "function testFn(): void",
    },
    score,
  };
}
