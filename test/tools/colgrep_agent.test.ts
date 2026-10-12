import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Mock } from "vitest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createAvailabilityState } from "#src/lib/availability";
import type { Exec } from "#src/lib/exec";
import {
  executeColGrepAgent,
  registerColGrepAgent,
} from "#src/tools/colgrep_agent";

// ---- mock node builtins (truncation path) ----

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

// ---- fixtures ----

const SAMPLE_JSON = JSON.stringify({
  query: "where are retries configured",
  locations: [
    { file: "/repo/src/retry.ts", start_line: 42, end_line: 60 },
    { file: "/repo/src/server.ts", start_line: 103, end_line: 118 },
  ],
  submitted: true,
  end_reason: "Answered",
  error: null,
  turns: 5,
  searches: 2,
  reads: 3,
  prompt_tokens: 1000,
  cached_prompt_tokens: 500,
  completion_tokens: 100,
  llm_seconds: 10,
  tool_seconds: 0.5,
  seconds: 21.7,
});

interface DepsOverrides {
  available?: boolean | undefined;
  modelInstalled?: boolean | undefined;
  enabled?: boolean;
  maxConcurrent?: number;
  timeoutMs?: number;
  maxLines?: number;
}

function makeDeps(exec: Mock<Exec>, overrides: DepsOverrides = {}) {
  const availability = createAvailabilityState();
  availability.available = overrides.available ?? true;
  return {
    exec,
    availability,
    isModelInstalled: () => overrides.modelInstalled ?? true,
    isEnabled: () => overrides.enabled ?? true,
    maxConcurrent: () => overrides.maxConcurrent ?? 1,
    timeoutMs: () => overrides.timeoutMs ?? 300_000,
    ...(overrides.maxLines !== undefined
      ? { maxLines: overrides.maxLines }
      : {}),
  };
}

// ---- executeColGrepAgent ----

describe("executeColGrepAgent", () => {
  let exec: Mock<Exec>;

  beforeEach(() => {
    exec = vi.fn<Exec>();
    mockWriteFile.mockReset();
    mockTmpdir.mockReset();
    mockTmpdir.mockReturnValue("/tmp");
  });

  it("errors when colgrep is unavailable", async () => {
    const deps = makeDeps(exec, { available: false });
    const result = await executeColGrepAgent(
      { question: "q" },
      deps,
      "/repo",
      undefined,
    );
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("install");
    expect(exec).not.toHaveBeenCalled();
  });

  it("errors with the install command when the model is missing", async () => {
    const deps = makeDeps(exec, { modelInstalled: false });
    const result = await executeColGrepAgent(
      { question: "q" },
      deps,
      "/repo",
      undefined,
    );
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("colgrep --install-agent");
    expect(exec).not.toHaveBeenCalled();
  });

  it("errors when disabled in config", async () => {
    const deps = makeDeps(exec, { enabled: false });
    const result = await executeColGrepAgent(
      { question: "q" },
      deps,
      "/repo",
      undefined,
    );
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("disabled");
    expect(exec).not.toHaveBeenCalled();
  });

  it("returns relativized locations and a meta summary on success", async () => {
    exec.mockResolvedValue({ stdout: SAMPLE_JSON, stderr: "", code: 0 });
    const deps = makeDeps(exec);
    const result = await executeColGrepAgent(
      { question: "where are retries configured", path: "./backend" },
      deps,
      "/repo",
      undefined,
    );
    expect(result.isError).toBe(false);
    const text = result.content[0].text;
    expect(text).toContain("src/retry.ts:42-60");
    expect(text).toContain("src/server.ts:103-118");
    expect(text).toContain("[colgrep_agent: 2 locations · 5 turns · 2 searches · 21.7s]");
    expect(result.details).toMatchObject({
      locationCount: 2,
      turns: 5,
      searches: 2,
      seconds: 21.7,
      truncated: false,
    });
    expect(exec).toHaveBeenCalledWith(
      "colgrep",
      [
        "--agent",
        "--json",
        "where are retries configured",
        "./backend",
      ],
      expect.objectContaining({ cwd: "/repo" }),
    );
  });

  it("reports an explicit empty result", async () => {
    exec.mockResolvedValue({
      stdout: JSON.stringify({ locations: [], error: null }),
      stderr: "",
      code: 0,
    });
    const result = await executeColGrepAgent(
      { question: "q" },
      makeDeps(exec),
      "/repo",
      undefined,
    );
    expect(result.isError).toBe(false);
    expect(result.content[0].text).toContain("No locations found");
    expect(result.details).toMatchObject({ locationCount: 0 });
  });

  it("propagates exec failures as errors", async () => {
    exec.mockResolvedValue({ stdout: "", stderr: "model exploded", code: 1 });
    const result = await executeColGrepAgent(
      { question: "q" },
      makeDeps(exec),
      "/repo",
      undefined,
    );
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("model exploded");
  });

  it("truncates long output and points at the full file", async () => {
    exec.mockResolvedValue({ stdout: SAMPLE_JSON, stderr: "", code: 0 });
    const result = await executeColGrepAgent(
      { question: "q" },
      makeDeps(exec, { maxLines: 1 }),
      "/repo",
      undefined,
    );
    expect(result.isError).toBe(false);
    expect(result.content[0].text).toContain("[Truncated. Full output:");
    expect(mockWriteFile).toHaveBeenCalledOnce();
    expect(result.details).toMatchObject({ truncated: true });
  });

  it("passes the configured timeout to exec", async () => {
    exec.mockResolvedValue({ stdout: SAMPLE_JSON, stderr: "", code: 0 });
    await executeColGrepAgent(
      { question: "q" },
      makeDeps(exec, { timeoutMs: 1234 }),
      "/repo",
      undefined,
    );
    expect(exec).toHaveBeenCalledWith(
      "colgrep",
      expect.any(Array),
      expect.objectContaining({ timeout: 1234 }),
    );
  });
});

// ---- registerColGrepAgent: tool registration + concurrency ----

interface CapturedTool {
  name: string;
  execute: (
    toolCallId: string,
    params: { question: string; path?: string },
    signal: AbortSignal | undefined,
    onUpdate: unknown,
    ctx: { cwd: string },
  ) => Promise<{ isError?: boolean; content: Array<{ text?: string }> }>;
}

function capturePi(): { pi: ExtensionAPI; tools: CapturedTool[] } {
  const tools: CapturedTool[] = [];
  const pi = {
    registerTool: (definition: CapturedTool) => {
      tools.push(definition);
    },
  } as unknown as ExtensionAPI;
  return { pi, tools };
}

describe("registerColGrepAgent", () => {
  it("registers a colgrep_agent tool with question/path parameters", () => {
    const { pi, tools } = capturePi();
    const exec = vi.fn<Exec>();
    registerColGrepAgent(pi, {
      exec,
      availability: createAvailabilityState(),
      isModelInstalled: () => true,
      isEnabled: () => true,
      maxConcurrent: () => 1,
      timeoutMs: () => 300_000,
    });
    expect(tools).toHaveLength(1);
    expect(tools[0].name).toBe("colgrep_agent");
  });

  it("rejects a second concurrent run", async () => {
    const { pi, tools } = capturePi();
    type ExecResult = { stdout: string; stderr: string; code: number };
    let resolveExec: ((value: ExecResult) => void) | undefined;
    const exec = vi.fn<Exec>(
      () =>
        new Promise<ExecResult>((resolve) => {
          resolveExec = resolve;
        }),
    );
    const availability = createAvailabilityState();
    availability.available = true;
    registerColGrepAgent(pi, {
      exec,
      availability,
      isModelInstalled: () => true,
      isEnabled: () => true,
      maxConcurrent: () => 1,
      timeoutMs: () => 300_000,
    });

    const ctx = { cwd: "/repo" };
    const first = tools[0].execute("1", { question: "a" }, undefined, undefined, ctx);
    const second = await tools[0].execute("2", { question: "b" }, undefined, undefined, ctx);
    expect(second.isError).toBe(true);
    expect(second.content[0].text).toContain("already in progress");

    resolveExec?.({ stdout: SAMPLE_JSON, stderr: "", code: 0 });
    const firstResult = await first;
    expect(firstResult.isError).toBe(false);

    // The limiter releases after completion: a new run is accepted.
    const thirdPromise = tools[0].execute(
      "3",
      { question: "c" },
      undefined,
      undefined,
      ctx,
    );
    resolveExec?.({ stdout: SAMPLE_JSON, stderr: "", code: 0 });
    const third = await thirdPromise;
    expect(third.content[0].text).not.toContain("already in progress");
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

function captureAgentTool(): RenderableTool {
  const { pi, tools } = capturePi();
  registerColGrepAgent(pi, {
    exec: vi.fn<Exec>(),
    availability: createAvailabilityState(),
    isModelInstalled: () => true,
    isEnabled: () => true,
    maxConcurrent: () => 1,
    timeoutMs: () => 300_000,
  });
  return tools[0] as unknown as RenderableTool;
}

const stubTheme = {
  fg: (color: string, text: string) => `<${color}>${text}`,
};

function renderAgent(result: unknown, options: { expanded: boolean }): string {
  const setText = vi.fn<(text: string) => void>();
  captureAgentTool().renderResult(
    result,
    { ...options, isPartial: false },
    stubTheme,
    { isError: false, lastComponent: { setText } },
  );
  return setText.mock.calls[0][0];
}

describe("colgrep_agent renderResult", () => {
  const successResult = {
    content: [
      {
        type: "text",
        text: "src/a.ts:1-2\nsrc/b.ts:3-4\n\n[colgrep_agent: 2 locations · 4 turns · 1 search · 6.8s]",
      },
    ],
    details: {
      locationCount: 2,
      turns: 4,
      searches: 1,
      seconds: 6.8,
      truncated: false,
    },
  };

  it("renders a collapsed summary with location preview and expand hint", () => {
    const text = renderAgent(successResult, { expanded: false });
    expect(text).toContain("2 locations");
    expect(text).toContain("4 turns");
    expect(text).toContain("src/a.ts:1-2");
    expect(text).toContain("ctrl+o to expand");
    expect(text).not.toContain("[colgrep_agent:");
  });

  it("renders the full output when expanded", () => {
    const text = renderAgent(successResult, { expanded: true });
    expect(text).toContain(
      "[colgrep_agent: 2 locations · 4 turns · 1 search · 6.8s]",
    );
  });

  it("renders no-locations without an expand hint", () => {
    const text = renderAgent(
      {
        content: [{ type: "text", text: "No locations found." }],
        details: { locationCount: 0 },
      },
      { expanded: false },
    );
    expect(text).toContain("no locations");
    expect(text).not.toContain("ctrl+o");
  });
});
