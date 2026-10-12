import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Exec } from "#src/lib/exec";
import {
  isRecoverableIndexError,
  isSafeIndexPath,
  parseIndexPath,
  recoverCorruptedIndex,
} from "#src/lib/index-recovery";

const cleanups: string[] = [];

function tmpDir(): string {
  const dir = join(
    tmpdir(),
    `pi-colgrep-recovery-${Date.now()}-${Math.random()}`,
  );
  mkdirSync(dir, { recursive: true });
  cleanups.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of cleanups) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {}
  }
  cleanups.length = 0;
});

describe("isRecoverableIndexError", () => {
  it("matches corruption errors", () => {
    expect(
      isRecoverableIndexError(
        "Error: Index load failed: Failed to open metadata: No such file or directory (os error 2)",
      ),
    ).toBe(true);
    expect(isRecoverableIndexError("Failed to open metadata")).toBe(true);
  });

  it("does not match unrelated outputs", () => {
    expect(
      isRecoverableIndexError("index is currently being built, rely on grep"),
    ).toBe(false);
    expect(isRecoverableIndexError("boom")).toBe(false);
  });
});

describe("parseIndexPath", () => {
  it("parses the Index line from colgrep status", () => {
    const out = "Project: /p\nModel:   m\nIndex:   /tmp/idx/proj-abcd1234\n";
    expect(parseIndexPath(out)).toBe("/tmp/idx/proj-abcd1234");
  });

  it("returns undefined when absent", () => {
    expect(parseIndexPath("No index found for /p")).toBeUndefined();
  });
});

describe("isSafeIndexPath", () => {
  it("accepts paths strictly inside the indices root", () => {
    expect(isSafeIndexPath("/root/indices/proj-abcd1234", "/root/indices")).toBe(
      true,
    );
  });

  it("refuses the root itself, sibling prefixes, and outside paths", () => {
    expect(isSafeIndexPath("/root/indices", "/root/indices")).toBe(false);
    expect(isSafeIndexPath("/root/indices-evil/x", "/root/indices")).toBe(false);
    expect(isSafeIndexPath("/etc/passwd", "/root/indices")).toBe(false);
  });
});

describe("recoverCorruptedIndex", () => {
  it("removes a corrupted index inside the root and returns its path", async () => {
    const root = tmpDir();
    const indexDir = join(root, "proj-abcd1234");
    mkdirSync(join(indexDir, "index"), { recursive: true });
    writeFileSync(join(indexDir, ".building"), "");
    const exec = vi.fn<Exec>().mockResolvedValue({
      stdout: `Project: /p\nIndex:   ${indexDir}\n`,
      stderr: "",
      code: 0,
    });

    const removed = await recoverCorruptedIndex(exec, "/p", {
      indicesRoot: root,
    });

    expect(removed).toBe(indexDir);
    expect(existsSync(indexDir)).toBe(false);
  });

  it("refuses to delete outside the indices root", async () => {
    const root = tmpDir();
    const outside = tmpDir();
    const exec = vi.fn<Exec>().mockResolvedValue({
      stdout: `Index:   ${outside}\n`,
      stderr: "",
      code: 0,
    });

    const removed = await recoverCorruptedIndex(exec, "/p", {
      indicesRoot: root,
    });

    expect(removed).toBeUndefined();
    expect(existsSync(outside)).toBe(true);
  });

  it("returns undefined when status reports no index", async () => {
    const exec = vi.fn<Exec>().mockResolvedValue({
      stdout: "No index found for /p\n",
      stderr: "",
      code: 0,
    });
    expect(
      await recoverCorruptedIndex(exec, "/p", { indicesRoot: tmpDir() }),
    ).toBeUndefined();
  });

  it("returns undefined when status fails", async () => {
    const exec = vi.fn<Exec>().mockRejectedValue(new Error("no colgrep"));
    expect(
      await recoverCorruptedIndex(exec, "/p", { indicesRoot: tmpDir() }),
    ).toBeUndefined();
  });
});
