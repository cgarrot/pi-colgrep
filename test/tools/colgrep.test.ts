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
  default: { tmpdir: mockTmpdir },
  tmpdir: mockTmpdir,
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

interface RenderableTool {
  renderResult: (
    result: unknown,
    options: { expanded: boolean; isPartial: boolean },
    theme: unknown,
    context: { isError: boolean; lastComponent: unknown },
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
};

function render(
  result: unknown,
  options: { expanded: boolean },
  isError: boolean,
): string {
  const setText = vi.fn<(text: string) => void>();
  captureTool().renderResult(
    result,
    { ...options, isPartial: false },
    stubTheme,
    { isError, lastComponent: { setText } },
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

  it("renders an expanded error as the full error text", () => {
    const text = render(errorResult, { expanded: true }, true);
    expect(text).toContain("colgrep is not installed or not available.");
    expect(text).toContain("Install it from: https://example.test");
  });
});
