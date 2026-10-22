import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Mock } from "vitest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createAvailabilityState } from "#src/lib/availability";
import type { Exec } from "#src/lib/exec";
import { executeColGrepSearch, registerColGrep } from "#src/tools/colgrep";

// ---- mock node builtins ----

const mockWriteFile = vi.hoisted(() =>
  vi.fn<(path: string, data: string) => Promise<void>>(),
);
const mockTmpdir = vi.hoisted(() => vi.fn(() => "/tmp"));

vi.mock("node:fs/promises", () => ({
  default: { writeFile: mockWriteFile },
  writeFile: mockWriteFile,
}));
vi.mock("node:os", () => ({
  default: { tmpdir: mockTmpdir, homedir: () => "/Users/test" },
  tmpdir: mockTmpdir,
  homedir: () => "/Users/test",
}));

// ---- tests ----

describe("executeColGrepSearch", () => {
  let exec: Mock<Exec>;

  beforeEach(() => {
    exec = vi.fn<Exec>();
    mockWriteFile.mockReset();
    mockTmpdir.mockReset();
    mockTmpdir.mockReturnValue("/tmp");
  });

  describe("availability gate", () => {
    it("returns error when availability has not been checked yet (undefined)", async () => {
      const availability = createAvailabilityState();
      // available starts as undefined
      const result = await executeColGrepSearch(
        { query: "auth" },
        { exec, availability },
        "/project",
        undefined,
      );
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("colgrep");
    });

    it("returns error with install instructions when colgrep is not installed", async () => {
      const availability = createAvailabilityState();
      availability.available = false;
      const result = await executeColGrepSearch(
        { query: "auth" },
        { exec, availability },
        "/project",
        undefined,
      );
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("colgrep");
      expect(result.content[0].text).toContain("install");
    });

    it("does not call exec when colgrep is unavailable", async () => {
      const availability = createAvailabilityState();
      availability.available = false;
      await executeColGrepSearch(
        { query: "auth" },
        { exec, availability },
        "/project",
        undefined,
      );
      expect(exec).not.toHaveBeenCalled();
    });
  });

  describe("parameter validation", () => {
    it("returns error when neither query nor regex is provided", async () => {
      const availability = createAvailabilityState();
      availability.available = true;
      const result = await executeColGrepSearch(
        {},
        { exec, availability },
        "/project",
        undefined,
      );
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("query");
      expect(result.content[0].text).toContain("regex");
    });
  });

  describe("successful search", () => {
    it("returns ok with formatted results", async () => {
      const availability = createAvailabilityState();
      availability.available = true;
      exec.mockResolvedValue({
        stdout: JSON.stringify([
          {
            unit: { file: "/project/src/auth.ts", line: 1, end_line: 5 },
            score: 0.9,
          },
        ]),
        stderr: "",
        code: 0,
      });
      const result = await executeColGrepSearch(
        { query: "auth logic" },
        { exec, availability },
        "/project",
        undefined,
      );
      expect(result.isError).toBe(false);
      expect(result.content[0].text).toContain("src/auth.ts:1-5 [score=0.900]");
    });

    it("does not write a temp file when output fits within limits", async () => {
      const availability = createAvailabilityState();
      availability.available = true;
      exec.mockResolvedValue({ stdout: "[]", stderr: "", code: 0 });
      await executeColGrepSearch(
        { query: "auth" },
        { exec, availability },
        "/project",
        undefined,
      );
      expect(mockWriteFile).not.toHaveBeenCalled();
    });

    it("forwards signal to the search", async () => {
      const availability = createAvailabilityState();
      availability.available = true;
      exec.mockResolvedValue({ stdout: "[]", stderr: "", code: 0 });
      const controller = new AbortController();
      await executeColGrepSearch(
        { query: "auth" },
        { exec, availability },
        "/project",
        controller.signal,
      );
      expect(exec).toHaveBeenCalledWith(
        "colgrep",
        expect.any(Array),
        expect.objectContaining({ signal: controller.signal }),
      );
    });
  });

  describe("error propagation", () => {
    it("returns err when runSearch reports an error", async () => {
      const availability = createAvailabilityState();
      availability.available = true;
      exec.mockResolvedValue({
        stdout: "",
        stderr: "index not found, run colgrep init",
        code: 1,
      });
      const result = await executeColGrepSearch(
        { query: "auth" },
        { exec, availability },
        "/project",
        undefined,
      );
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("index not found");
    });
  });

  describe("truncation", () => {
    it("writes full output to a temp file and appends its path when truncated", async () => {
      const availability = createAvailabilityState();
      availability.available = true;
      // 3 hits → 3-line output; set maxLines=2 to force truncation
      const hits = [
        { unit: { file: "/project/a.ts", line: 1, end_line: 2 }, score: 0.9 },
        { unit: { file: "/project/b.ts", line: 3, end_line: 4 }, score: 0.8 },
        { unit: { file: "/project/c.ts", line: 5, end_line: 6 }, score: 0.7 },
      ];
      exec.mockResolvedValue({
        stdout: JSON.stringify(hits),
        stderr: "",
        code: 0,
      });
      mockWriteFile.mockResolvedValue(undefined);

      const result = await executeColGrepSearch(
        { query: "auth" },
        { exec, availability, maxLines: 2 },
        "/project",
        undefined,
      );

      expect(result.isError).toBe(false);
      expect(mockWriteFile).toHaveBeenCalledOnce();
      expect(result.content[0].text).toContain("Full output:");
      expect(result.content[0].text).toContain("/tmp/");
    });

    it("does not write a temp file when output is within maxLines limit", async () => {
      const availability = createAvailabilityState();
      availability.available = true;
      exec.mockResolvedValue({
        stdout: JSON.stringify([
          { unit: { file: "/project/a.ts", line: 1, end_line: 2 }, score: 0.9 },
        ]),
        stderr: "",
        code: 0,
      });

      await executeColGrepSearch(
        { query: "auth" },
        { exec, availability, maxLines: 10 },
        "/project",
        undefined,
      );
      expect(mockWriteFile).not.toHaveBeenCalled();
    });
  });
});

// ---- renderResult ----

interface RenderContext {
  isError: boolean;
  lastComponent: unknown;
  state: Record<string, unknown>;
  invalidate: () => void;
  executionStarted: boolean;
  isPartial: boolean;
  durationMs?: number;
}

interface RenderableTool {
  renderCall: (
    args: Record<string, unknown>,
    theme: unknown,
    context: RenderContext,
  ) => unknown;
  renderResult: (
    result: unknown,
    options: { expanded: boolean; isPartial: boolean },
    theme: unknown,
    context: RenderContext,
  ) => unknown;
}

function captureTool(): RenderableTool {
  const registerTool = vi.fn();
  const availability = createAvailabilityState();
  registerColGrep({ registerTool } as unknown as ExtensionAPI, {
    exec: vi.fn<Exec>(),
    availability,
  });
  return registerTool.mock.calls[0][0] as RenderableTool;
}

const stubTheme = {
  fg: (color: string, text: string) => `<${color}>${text}`,
  bold: (text: string) => text,
};

function makeContext(overrides: Partial<RenderContext> = {}): RenderContext {
  return {
    isError: false,
    lastComponent: undefined,
    state: {},
    invalidate: vi.fn(),
    executionStarted: false,
    isPartial: false,
    durationMs: undefined,
    ...overrides,
  };
}

function render(
  result: unknown,
  options: { expanded: boolean; isPartial?: boolean },
  isError: boolean,
  overrides: Partial<RenderContext> = {},
): string {
  const setText = vi.fn<(text: string) => void>();
  captureTool().renderResult(
    result,
    { expanded: options.expanded, isPartial: options.isPartial ?? false },
    stubTheme,
    makeContext({ ...overrides, isError, lastComponent: { setText } }),
  );
  return setText.mock.calls[0][0];
}

function renderCall(
  args: Record<string, unknown>,
  overrides: Partial<RenderContext> = {},
): string {
  const setText = vi.fn<(text: string) => void>();
  captureTool().renderCall(
    args,
    stubTheme,
    makeContext({
      ...overrides,
      isPartial: overrides.isPartial ?? true,
      lastComponent: { setText },
    }),
  );
  return setText.mock.calls[0][0];
}

describe("renderResult", () => {
  const errorResult = {
    content: [
      {
        type: "text",
        text: "colgrep is not installed or not available.\nInstall it from: https://example.test",
      },
    ],
    details: undefined,
  };

  it("renders a collapsed error as ✗ with the error's first line", () => {
    const text = render(errorResult, { expanded: false }, true);
    expect(text).toContain("<error>✗");
    expect(text).toContain("colgrep is not installed or not available.");
    expect(text).not.toContain("Install it from");
    expect(text).not.toContain("<success>✓");
  });

  it("renders a collapsed success as ✓ with the hit count", () => {
    const text = render(
      {
        content: [{ type: "text", text: "a.ts:1\nb.ts:2" }],
        details: { hitCount: 2, truncated: false },
      },
      { expanded: false },
      false,
    );
    expect(text).toContain("<success>✓");
    expect(text).toContain("2 hits");
    expect(text).not.toContain("<error>");
  });

  it("renders a collapsed success with a preview and an expand hint", () => {
    const text = render(
      {
        content: [
          { type: "text", text: "a.ts:1\nb.ts:2\nc.ts:3\nd.ts:4\ne.ts:5" },
        ],
        details: { hitCount: 5, truncated: false },
      },
      { expanded: false },
      false,
    );
    expect(text).toContain("5 hits");
    expect(text).toContain("a.ts:1");
    expect(text).toContain("c.ts:3");
    expect(text).not.toContain("d.ts:4");
    expect(text).toContain("+2 more");
    expect(text).toContain("ctrl+o to expand");
  });

  it("marks truncated collapsed results", () => {
    const text = render(
      {
        content: [{ type: "text", text: "a.ts:1" }],
        details: { hitCount: 1, truncated: true },
      },
      { expanded: false },
      false,
    );
    expect(text).toContain("truncated");
  });

  it("renders no-matches without an expand hint", () => {
    const text = render(
      {
        content: [{ type: "text", text: "No matches found" }],
        details: { hitCount: 0, truncated: false },
      },
      { expanded: false },
      false,
    );
    expect(text).toContain("no matches");
    expect(text).not.toContain("ctrl+o");
  });

  it("renders an expanded error as the full error text", () => {
    const text = render(errorResult, { expanded: true }, true);
    expect(text).toContain("colgrep is not installed or not available.");
    expect(text).toContain("Install it from: https://example.test");
  });
});

// ---- timer ----

describe("tool timer", () => {
  const hitResult = {
    content: [{ type: "text", text: "a.ts:1" }],
    details: { hitCount: 1, truncated: false },
  };

  it("shows a live elapsed counter on the call line while the search runs", () => {
    const text = renderCall(
      { query: "auth" },
      {
        executionStarted: true,
        isPartial: true,
        state: { startedAt: Date.now() - 2300 },
      },
    );
    expect(text).toContain("colgrep");
    expect(text).toContain("Elapsed 2.3s");
  });

  it("shows no counter before the execution started", () => {
    const text = renderCall({ query: "auth" }, { executionStarted: false });
    expect(text).not.toContain("Elapsed");
  });

  it("drops the live counter once the result is final", () => {
    const text = renderCall(
      { query: "auth" },
      {
        executionStarted: true,
        isPartial: false,
        state: { startedAt: Date.now() - 2300 },
      },
    );
    expect(text).not.toContain("Elapsed");
  });

  it("shows the total duration under the final result", () => {
    const text = render(
      hitResult,
      { expanded: false },
      false,
      { executionStarted: true, durationMs: 4200 },
    );
    expect(text).toContain("Took 4.2s");
  });

  it("shows the total duration under an error result", () => {
    const text = render(
      {
        content: [{ type: "text", text: "colgrep is at capacity." }],
        details: undefined,
      },
      { expanded: false },
      true,
      { executionStarted: true, durationMs: 30_000 },
    );
    expect(text).toContain("Took 30.0s");
  });

  it("falls back to the renderer's own clock when Pi recorded no duration", () => {
    const text = render(
      hitResult,
      { expanded: false },
      false,
      { executionStarted: true, state: { startedAt: Date.now() - 1500 } },
    );
    expect(text).toContain("Took 1.5s");
  });

  it("shows no duration when the call never ran", () => {
    const text = render(hitResult, { expanded: false }, false);
    expect(text).not.toContain("Took");
  });

  it("keeps counting up as the row is redrawn", () => {
    vi.useFakeTimers();
    const state: Record<string, unknown> = {};
    const invalidate = vi.fn();
    const overrides = {
      executionStarted: true,
      isPartial: true,
      state,
      invalidate,
    };

    const first = renderCall({ query: "auth" }, overrides);
    expect(first).toContain("Elapsed 0.0s");

    // The ticker redraws the row once per second.
    vi.advanceTimersByTime(2000);
    expect(invalidate).toHaveBeenCalledTimes(2);

    const second = renderCall({ query: "auth" }, overrides);
    expect(second).toContain("Elapsed 2.0s");

    vi.useRealTimers();
  });
});

// ---- waitForIndexIdle ----

describe("executeColGrepSearch — index idle wait", () => {  it("awaits waitForIndexIdle before searching", async () => {
    const order: string[] = [];
    const availability = createAvailabilityState();
    availability.available = true;
    const exec = vi.fn<Exec>(async () => {
      order.push("exec");
      return { stdout: "[]", stderr: "", code: 0 };
    });

    const result = await executeColGrepSearch(
      { query: "auth" },
      {
        exec,
        availability,
        waitForIndexIdle: async () => {
          order.push("idle");
        },
      },
      "/project",
      undefined,
    );

    expect(order).toEqual(["idle", "exec"]);
    expect(result.isError).toBe(false);
  });

  it("self-heals a corrupted index and retries once", async () => {
    const availability = createAvailabilityState();
    availability.available = true;
    const exec = vi
      .fn<Exec>()
      .mockResolvedValueOnce({
        stdout: "",
        stderr:
          "Error: Index load failed: Failed to open metadata: No such file or directory (os error 2)",
        code: 1,
      })
      .mockResolvedValueOnce({ stdout: "[]", stderr: "", code: 0 });
    const recoverIndex = vi.fn(async () => "/tmp/idx/proj-abcd1234");

    const result = await executeColGrepSearch(
      { query: "auth" },
      { exec, availability, recoverIndex },
      "/project",
      undefined,
    );

    expect(recoverIndex).toHaveBeenCalledOnce();
    expect(exec).toHaveBeenCalledTimes(2);
    expect(result.isError).toBe(false);
  });

  it("returns a capacity error when no machine-wide slot is available", async () => {
    const availability = createAvailabilityState();
    availability.available = true;
    const exec = vi.fn<Exec>();
    const result = await executeColGrepSearch(
      { query: "auth" },
      {
        exec,
        availability,
        withSearchSlot: async <T,>() => undefined,
      },
      "/project",
      undefined,
    );
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("capacity");
    expect(exec).not.toHaveBeenCalled();
  });

  it("refuses to search unsafe roots (home directory, root)", async () => {
    const availability = createAvailabilityState();
    availability.available = true;
    const exec = vi.fn<Exec>();
    const result = await executeColGrepSearch(
      { query: "auth" },
      { exec, availability },
      "/",
      undefined,
    );
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("home directory");
    expect(exec).not.toHaveBeenCalled();
  });

  it("returns the preflight block reason for oversized directories", async () => {
    const availability = createAvailabilityState();
    availability.available = true;
    const exec = vi.fn<Exec>();
    const result = await executeColGrepSearch(
      { query: "auth" },
      {
        exec,
        availability,
        preflightIndex: async () => "too large, scope to a subdirectory",
      },
      "/big",
      undefined,
    );
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("too large");
    expect(exec).not.toHaveBeenCalled();
  });
});
