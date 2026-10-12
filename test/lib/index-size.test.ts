import { describe, expect, it, vi } from "vitest";
import type { Exec } from "#src/lib/exec";
import {
  buildCountCommand,
  countFilesUpTo,
  exceedsCap,
  tooLargeMessage,
} from "#src/lib/index-size";

describe("buildCountCommand", () => {
  it("caps the count with head and prunes noise directories", () => {
    const command = buildCountCommand(100);
    expect(command).toContain("head -n 101");
    expect(command).toContain("-name .git");
    expect(command).toContain("node_modules");
    expect(command).toContain("-type f");
  });
});

describe("countFilesUpTo", () => {
  it("parses the count and runs a bounded scan in the target dir", async () => {
    const exec = vi.fn<Exec>(async () => ({
      stdout: "42\n",
      stderr: "",
      code: 0,
    }));
    await expect(countFilesUpTo(exec, "/p", 100)).resolves.toBe(42);
    expect(exec).toHaveBeenCalledWith(
      "/bin/sh",
      ["-c", expect.stringContaining("head -n 101")],
      expect.objectContaining({ cwd: "/p" }),
    );
  });

  it("returns undefined on non-zero exit", async () => {
    const exec = vi.fn<Exec>(async () => ({
      stdout: "",
      stderr: "boom",
      code: 1,
    }));
    await expect(countFilesUpTo(exec, "/p", 100)).resolves.toBeUndefined();
  });

  it("returns undefined on unparseable output", async () => {
    const exec = vi.fn<Exec>(async () => ({
      stdout: "nope",
      stderr: "",
      code: 0,
    }));
    await expect(countFilesUpTo(exec, "/p", 100)).resolves.toBeUndefined();
  });

  it("returns undefined when exec throws", async () => {
    const exec = vi.fn<Exec>(async () => {
      throw new Error("timeout");
    });
    await expect(countFilesUpTo(exec, "/p", 100)).resolves.toBeUndefined();
  });
});

describe("exceedsCap", () => {
  it("is true only above a positive cap", () => {
    expect(exceedsCap(101, 100)).toBe(true);
    expect(exceedsCap(100, 100)).toBe(false);
    expect(exceedsCap(undefined, 100)).toBe(false);
    expect(exceedsCap(999, 0)).toBe(false);
  });
});

describe("tooLargeMessage", () => {
  it("mentions the cap and the scoping hint", () => {
    const message = tooLargeMessage("/big", 20_001, 20_000);
    expect(message).toContain("20,000");
    expect(message).toContain("subdirectory");
  });
});
