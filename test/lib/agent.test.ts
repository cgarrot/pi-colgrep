import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  AGENT_MODEL_HF_DIR,
  buildAgentArgs,
  formatAgentLocation,
  formatAgentLocations,
  isAgentModelInstalled,
  parseAgentResult,
  runAgent,
} from "#src/lib/agent";
import type { Exec } from "#src/lib/exec";

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

function fakeExec(
  result:
    | { stdout: string; stderr: string; code: number }
    | Error,
): { exec: Exec; calls: Array<{ cmd: string; args: string[]; cwd?: string }> } {
  const calls: Array<{ cmd: string; args: string[]; cwd?: string }> = [];
  const exec: Exec = async (cmd, args, opts) => {
    calls.push({ cmd, args, cwd: opts?.cwd });
    if (result instanceof Error) throw result;
    return result;
  };
  return { exec, calls };
}

describe("buildAgentArgs", () => {
  it("builds question-only args", () => {
    expect(buildAgentArgs({ question: "where is auth handled" })).toEqual([
      "--agent",
      "--json",
      "where is auth handled",
    ]);
  });

  it("appends the path after the question", () => {
    expect(
      buildAgentArgs({ question: "where is auth handled", path: "./backend" }),
    ).toEqual(["--agent", "--json", "where is auth handled", "./backend"]);
  });
});

describe("parseAgentResult", () => {
  it("parses locations and meta from the captured schema", () => {
    const outcome = parseAgentResult(SAMPLE_JSON);
    expect(outcome.kind).toBe("ok");
    if (outcome.kind !== "ok") return;
    expect(outcome.locations).toEqual([
      { file: "/repo/src/retry.ts", startLine: 42, endLine: 60 },
      { file: "/repo/src/server.ts", startLine: 103, endLine: 118 },
    ]);
    expect(outcome.meta).toEqual({
      turns: 5,
      searches: 2,
      reads: 3,
      seconds: 21.7,
      submitted: true,
      endReason: "Answered",
    });
  });

  it("accepts an empty locations array", () => {
    const outcome = parseAgentResult(
      JSON.stringify({ locations: [], error: null }),
    );
    expect(outcome.kind).toBe("ok");
    if (outcome.kind !== "ok") return;
    expect(outcome.locations).toEqual([]);
    expect(outcome.meta.turns).toBe(0);
    expect(outcome.meta.submitted).toBe(false);
  });

  it("reports a non-null error field as agent_error", () => {
    const outcome = parseAgentResult(
      JSON.stringify({ locations: [], error: "model failed to load" }),
    );
    expect(outcome).toEqual({
      kind: "agent_error",
      message: "model failed to load",
    });
  });

  it("falls back to unparsable for invalid JSON", () => {
    const outcome = parseAgentResult("not json");
    expect(outcome.kind).toBe("unparsable");
  });

  it("falls back to unparsable for a non-object payload", () => {
    expect(parseAgentResult("[1,2]").kind).toBe("unparsable");
    expect(parseAgentResult("42").kind).toBe("unparsable");
  });

  it("falls back to unparsable when locations is missing", () => {
    expect(parseAgentResult(JSON.stringify({ error: null })).kind).toBe(
      "unparsable",
    );
  });

  it("skips malformed location entries without failing", () => {
    const outcome = parseAgentResult(
      JSON.stringify({
        locations: [
          { file: "/ok.ts", start_line: 1, end_line: 2 },
          { file: 42, start_line: 1, end_line: 2 },
          { nope: true },
        ],
        error: null,
      }),
    );
    expect(outcome.kind).toBe("ok");
    if (outcome.kind !== "ok") return;
    expect(outcome.locations).toEqual([
      { file: "/ok.ts", startLine: 1, endLine: 2 },
    ]);
  });
});

describe("formatAgentLocation(s)", () => {
  it("relativizes paths inside cwd", () => {
    expect(
      formatAgentLocation(
        { file: "/repo/src/retry.ts", startLine: 42, endLine: 60 },
        "/repo",
      ),
    ).toBe("src/retry.ts:42-60");
  });

  it("keeps absolute paths outside cwd", () => {
    expect(
      formatAgentLocation(
        { file: "/elsewhere/x.ts", startLine: 1, endLine: 2 },
        "/repo",
      ),
    ).toBe("/elsewhere/x.ts:1-2");
  });

  it("joins multiple locations with newlines", () => {
    const text = formatAgentLocations(
      [
        { file: "/repo/a.ts", startLine: 1, endLine: 2 },
        { file: "/repo/b.ts", startLine: 3, endLine: 4 },
      ],
      "/repo",
    );
    expect(text).toBe("a.ts:1-2\nb.ts:3-4");
  });
});

describe("isAgentModelInstalled", () => {
  const tmpDirs: string[] = [];

  function makeHub(): string {
    const dir = join(
      tmpdir(),
      `pi-colgrep-agent-test-${Date.now()}-${Math.random()}`,
    );
    mkdirSync(join(dir, AGENT_MODEL_HF_DIR, "blobs"), { recursive: true });
    tmpDirs.push(dir);
    return dir;
  }

  afterEach(() => {
    for (const dir of tmpDirs) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {}
    }
    tmpDirs.length = 0;
  });

  it("returns true when a large blob is present", async () => {
    const hub = makeHub();
    writeFileSync(
      join(hub, AGENT_MODEL_HF_DIR, "blobs", "f238da91"),
      Buffer.alloc(64),
    );
    await expect(
      isAgentModelInstalled({ hfHubDir: hub, minBytes: 16 }),
    ).resolves.toBe(true);
  });

  it("returns false when blobs are smaller than the threshold", async () => {
    const hub = makeHub();
    writeFileSync(
      join(hub, AGENT_MODEL_HF_DIR, "blobs", "tiny"),
      Buffer.alloc(4),
    );
    await expect(
      isAgentModelInstalled({ hfHubDir: hub, minBytes: 16 }),
    ).resolves.toBe(false);
  });

  it("returns false when the model directory is missing", async () => {
    const hub = join(tmpdir(), `missing-${Date.now()}`);
    await expect(isAgentModelInstalled({ hfHubDir: hub })).resolves.toBe(false);
  });
});

describe("runAgent", () => {
  it("returns locations and meta on success", async () => {
    const { exec, calls } = fakeExec({
      stdout: SAMPLE_JSON,
      stderr: "",
      code: 0,
    });
    const outcome = await runAgent(
      exec,
      { question: "where are retries configured" },
      "/repo",
      { timeoutMs: 1234 },
    );
    expect(outcome.kind).toBe("ok");
    if (outcome.kind !== "ok") return;
    expect(outcome.locations).toHaveLength(2);
    expect(outcome.meta.turns).toBe(5);
    expect(calls).toEqual([
      {
        cmd: "colgrep",
        args: ["--agent", "--json", "where are retries configured"],
        cwd: "/repo",
      },
    ]);
  });

  it("surfaces stderr on a non-zero exit", async () => {
    const { exec } = fakeExec({
      stdout: "",
      stderr: "model not found",
      code: 2,
    });
    const outcome = await runAgent(exec, { question: "q" }, "/repo");
    expect(outcome).toEqual({ kind: "error", message: "model not found" });
  });

  it("falls back to the exit code when stderr is empty", async () => {
    const { exec } = fakeExec({ stdout: "", stderr: "", code: 3 });
    const outcome = await runAgent(exec, { question: "q" }, "/repo");
    expect(outcome).toEqual({
      kind: "error",
      message: "colgrep --agent exited with exit code 3",
    });
  });

  it("surfaces thrown exec errors", async () => {
    const { exec } = fakeExec(new Error("spawn failed"));
    const outcome = await runAgent(exec, { question: "q" }, "/repo");
    expect(outcome.kind).toBe("error");
    if (outcome.kind !== "error") return;
    expect(outcome.message).toContain("spawn failed");
  });

  it("maps an agent_error payload to an error", async () => {
    const { exec } = fakeExec({
      stdout: JSON.stringify({ locations: [], error: "boom" }),
      stderr: "",
      code: 0,
    });
    const outcome = await runAgent(exec, { question: "q" }, "/repo");
    expect(outcome).toEqual({ kind: "error", message: "boom" });
  });

  it("maps unparsable output to an error containing the raw text", async () => {
    const { exec } = fakeExec({ stdout: "???", stderr: "", code: 0 });
    const outcome = await runAgent(exec, { question: "q" }, "/repo");
    expect(outcome.kind).toBe("error");
    if (outcome.kind !== "error") return;
    expect(outcome.message).toContain("???");
  });
});
