/**
 * Progress-aware index builder.
 *
 * colgrep prints a progress bar only when stdout is a TTY. We run it under a
 * pseudo-terminal (`script -q <log>` on macOS), tail the log file, and parse
 * the `current/total` pairs so the TUI widget can show a real percentage
 * while the build runs.
 *
 * Non-macOS (or when `script` is unavailable) falls back to a plain spawn
 * without progress.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { openSync, readSync, closeSync } from "node:fs";

export interface BuildProgress {
  current?: number;
  total?: number;
  percent?: number;
}

export type BuildProgressCallback = (progress: BuildProgress) => void;

export interface BuildResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Strip ANSI escapes and collapse carriage-return rewrites. */
export function cleanPtyOutput(raw: string): string {
  return raw
    // ANSI CSI/OSC sequences.
    .replace(/\u001b\][^\u0007]*\u0007/g, "")
    .replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, "")
    // Carriage-return progress rewrites: keep the last state per line.
    .split("\r")
    .join("\n");
}

/**
 * Extract the last `current/total` progress pair from PTY output.
 * Returns undefined when no plausible pair exists.
 */
export function parseBuildProgress(raw: string): BuildProgress | undefined {
  const text = cleanPtyOutput(raw);
  let last: RegExpExecArray | undefined;
  const pattern = /(\d[\d,]*)\s*\/\s*(\d[\d,]*)/g;
  for (const match of text.matchAll(pattern)) {
    last = match as RegExpExecArray;
  }
  if (!last) return undefined;
  const current = Number.parseInt(last[1].replace(/,/g, ""), 10);
  const total = Number.parseInt(last[2].replace(/,/g, ""), 10);
  if (!Number.isFinite(current) || !Number.isFinite(total) || total <= 0) {
    return undefined;
  }
  return {
    current,
    total,
    percent: Math.min(100, Math.round((current / total) * 100)),
  };
}

export interface RunBuildOptions {
  cwd: string;
  args: string[];
  timeoutMs: number;
  /** File receiving the PTY transcript (cleared/reused per build). */
  logPath: string;
  onProgress?: BuildProgressCallback;
  pollMs?: number;
  /** Injectable spawn (tests). Defaults to child_process.spawn. */
  spawnFn?: typeof spawn;
  /** Force-disable the PTY path (tests / non-macOS). */
  usePty?: boolean;
}

const PTY_TAIL_BYTES = 8 * 1024;

function readTail(path: string, bytes: number): string {
  try {
    const size = statSync(path).size;
    if (size === 0) return "";
    const fd = openSync(path, "r");
    try {
      const start = Math.max(0, size - bytes);
      const buffer = Buffer.alloc(size - start);
      readSync(fd, buffer, 0, buffer.length, start);
      return buffer.toString("utf-8");
    } finally {
      closeSync(fd);
    }
  } catch {
    return "";
  }
}

/** Run `colgrep <args>` in `cwd`, streaming progress when a PTY is used. */
export function runIndexBuild(options: RunBuildOptions): Promise<BuildResult> {
  const {
    cwd,
    args,
    timeoutMs,
    logPath,
    onProgress,
    pollMs = 700,
    spawnFn = spawn,
  } = options;
  const usePty =
    options.usePty ?? (process.platform === "darwin" && existsSync("/usr/bin/script"));

  const command = "colgrep";
  const commandArgs = [...args];
  const [file, spawnArgs] = usePty
    ? ["/usr/bin/script", ["-q", logPath, command, ...commandArgs]]
    : [command, commandArgs];

  return new Promise<BuildResult>((resolve) => {
    let child: ChildProcess;
    try {
      child = spawnFn(file, spawnArgs, {
        cwd,
        stdio: usePty ? ["ignore", "ignore", "ignore"] : ["ignore", "pipe", "pipe"],
      });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      resolve({ code: -1, stdout: "", stderr: reason });
      return;
    }

    let stdout = "";
    let stderr = "";
    let lastPercent = -1;
    let settled = false;

    if (!usePty) {
      child.stdout?.on("data", (chunk: Buffer) => {
        stdout += chunk.toString("utf-8");
      });
      child.stderr?.on("data", (chunk: Buffer) => {
        stderr += chunk.toString("utf-8");
      });
    }

    const poll = usePty
      ? setInterval(() => {
          if (!onProgress) return;
          const progress = parseBuildProgress(readTail(logPath, PTY_TAIL_BYTES));
          if (!progress) return;
          if (progress.percent === lastPercent) return;
          lastPercent = progress.percent ?? -1;
          onProgress(progress);
        }, pollMs)
      : undefined;

    const killTimer = setTimeout(() => {
      if (settled) return;
      child.kill("SIGTERM");
      setTimeout(() => {
        if (!settled) child.kill("SIGKILL");
      }, 3_000);
    }, timeoutMs);

    const finish = (code: number) => {
      if (settled) return;
      settled = true;
      if (poll) clearInterval(poll);
      clearTimeout(killTimer);
      if (usePty) {
        // Script writes the PTY transcript to the log file; the final line is
        // colgrep's summary. stdout/stderr stay empty in PTY mode.
        stdout = cleanPtyOutput(readTail(logPath, 1024 * 1024));
      }
      resolve({ code, stdout, stderr });
    };

    child.on("error", (err) => {
      stderr = err instanceof Error ? err.message : String(err);
      finish(-1);
    });
    child.on("close", (code) => {
      finish(code ?? -1);
    });
  });
}
