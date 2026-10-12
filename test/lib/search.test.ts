import type { Mock } from "vitest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Exec } from "#src/lib/exec";
import { runSearch, SEARCH_TIMEOUT_MS } from "#src/lib/search";

const cwd = "/project";

describe("runSearch", () => {
  let exec: Mock<Exec>;

  beforeEach(() => {
    exec = vi.fn<Exec>();
  });

  it("returns formatted hits on success", async () => {
    const hits = [
      {
        unit: { file: `${cwd}/src/auth.ts`, line: 1, end_line: 10 },
        score: 0.9,
      },
    ];
    exec.mockResolvedValue({
      stdout: JSON.stringify(hits),
      stderr: "",
      code: 0,
    });
    const result = await runSearch(exec, { query: "auth logic" }, cwd);
    expect(result.error).toBeUndefined();
    expect(result.output).toBe("src/auth.ts:1-10 [score=0.900]");
  });

  it("returns 'No matches found' for an empty result set", async () => {
    exec.mockResolvedValue({ stdout: "[]", stderr: "", code: 0 });
    const result = await runSearch(exec, { query: "nothing" }, cwd);
    expect(result.error).toBeUndefined();
    expect(result.output).toBe("No matches found");
  });

  it("passes cwd to exec", async () => {
    exec.mockResolvedValue({ stdout: "[]", stderr: "", code: 0 });
    await runSearch(exec, { query: "auth" }, cwd);
    expect(exec).toHaveBeenCalledWith(
      "colgrep",
      expect.any(Array),
      expect.objectContaining({ cwd }),
    );
  });

  it("forwards signal to exec", async () => {
    exec.mockResolvedValue({ stdout: "[]", stderr: "", code: 0 });
    const controller = new AbortController();
    await runSearch(exec, { query: "auth" }, cwd, controller.signal);
    expect(exec).toHaveBeenCalledWith(
      "colgrep",
      expect.any(Array),
      expect.objectContaining({ signal: controller.signal }),
    );
  });

  it("returns error when colgrep exits non-zero with stderr", async () => {
    exec.mockResolvedValue({
      stdout: "",
      stderr: "index not found, run colgrep init",
      code: 1,
    });
    const result = await runSearch(exec, { query: "auth" }, cwd);
    expect(result.output).toBeUndefined();
    expect(result.error).toContain("index not found");
  });

  it("returns error when colgrep exits non-zero with no stderr", async () => {
    exec.mockResolvedValue({ stdout: "", stderr: "", code: 2 });
    const result = await runSearch(exec, { query: "auth" }, cwd);
    expect(result.output).toBeUndefined();
    expect(result.error).toContain("exit code 2");
  });

  it("uses params.path as the search directory for path relativization", async () => {
    const hits = [
      {
        unit: { file: `${cwd}/lib/util.ts`, line: 3, end_line: 8 },
        score: 0.5,
      },
    ];
    exec.mockResolvedValue({
      stdout: JSON.stringify(hits),
      stderr: "",
      code: 0,
    });
    const result = await runSearch(
      exec,
      { query: "util", path: `${cwd}/lib` },
      cwd,
    );
    // path relativized against params.path, not cwd
    expect(result.output).toBe("util.ts:3-8 [score=0.500]");
  });
});

describe("runSearch — index rebuild contention", () => {
  let exec: Mock<Exec>;

  beforeEach(() => {
    exec = vi.fn<Exec>();
  });

  const BUILDING =
    "colgrep index is currently being built, rely on grep for now.";

  it("retries while the index is being built, then succeeds", async () => {
    exec
      .mockResolvedValueOnce({ stdout: "", stderr: BUILDING, code: 1 })
      .mockResolvedValueOnce({ stdout: "[]", stderr: "", code: 0 });
    const sleeps: number[] = [];
    const retries: number[] = [];
    const result = await runSearch(exec, { query: "q" }, "/repo", undefined, {
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      onRetry: (attempt) => {
        retries.push(attempt);
      },
    });
    expect(result.error).toBeUndefined();
    expect(result.output).toBe("No matches found");
    expect(exec).toHaveBeenCalledTimes(2);
    expect(sleeps).toEqual([2_000]);
    expect(retries).toEqual([1]);
  });

  it("gives up after the budget with actionable guidance", async () => {
    exec.mockResolvedValue({ stdout: "", stderr: BUILDING, code: 1 });
    const result = await runSearch(exec, { query: "q" }, "/repo", undefined, {
      retryBudgetMs: 1_000,
      sleep: async () => {},
    });
    expect(result.output).toBeUndefined();
    expect(result.error).toContain("still running");
    expect(result.error).toContain("retry this search in a moment");
    expect(result.error).toContain(
      "instead of falling back to recursive grep",
    );
  });

  it("does not retry unrelated failures", async () => {
    exec.mockResolvedValue({ stdout: "", stderr: "boom", code: 1 });
    const result = await runSearch(exec, { query: "q" }, "/repo", undefined, {
      sleep: async () => {},
    });
    expect(result).toEqual({ error: "boom" });
    expect(exec).toHaveBeenCalledTimes(1);
  });

  it("caps each attempt with the default search timeout", async () => {
    exec.mockResolvedValue({ stdout: "[]", stderr: "", code: 0 });
    await runSearch(exec, { query: "q" }, "/repo");
    expect(exec).toHaveBeenCalledWith(
      "colgrep",
      expect.any(Array),
      expect.objectContaining({ timeout: SEARCH_TIMEOUT_MS }),
    );
  });

  it("turns an exec rejection into an actionable error", async () => {
    exec.mockRejectedValue(new Error("exec timed out"));
    const result = await runSearch(exec, { query: "q" }, "/repo", undefined, {
      timeoutMs: 1_000,
      sleep: async () => {},
    });
    expect(result.error).toContain("colgrep search failed");
    expect(result.error).toContain("exec timed out");
  });
});
