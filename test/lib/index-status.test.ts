import type { Mock } from "vitest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Exec } from "#src/lib/exec";
import { checkIndexExists, indexExistsFromStatus } from "#src/lib/index-status";

// Fixtures captured from the real `colgrep status` CLI output.
const NOT_INDEXED = `No index found for /private/tmp/example [lightonai/LateOn-Code-edge]
Run \`colgrep <query>\` to create one.
`;

const INDEXED = `Project: /private/tmp/example
Model:   lightonai/LateOn-Code-edge
Index:   /Users/me/Library/Application Support/colgrep/indices/example-e1ff4c04

Run any search to update the index, or \`colgrep clear\` to rebuild from scratch.
`;

describe("indexExistsFromStatus", () => {
  it("returns false when status reports no index", () => {
    expect(indexExistsFromStatus(NOT_INDEXED)).toBe(false);
  });

  it("returns true when status reports an index", () => {
    expect(indexExistsFromStatus(INDEXED)).toBe(true);
  });

  it("returns true for unrecognized output (degrade to assuming an index)", () => {
    expect(indexExistsFromStatus("")).toBe(true);
  });
});

describe("checkIndexExists", () => {
  let exec: Mock<Exec>;

  beforeEach(() => {
    exec = vi.fn<Exec>();
  });

  it("runs colgrep status with the cwd and plain color", async () => {
    exec.mockResolvedValue({ stdout: INDEXED, stderr: "", code: 0 });
    await checkIndexExists(exec, "/my/project");
    expect(exec).toHaveBeenCalledWith(
      "colgrep",
      ["status", "/my/project", "--color", "never"],
      { cwd: "/my/project", timeout: 5000 },
    );
  });

  it("returns true when status output shows an index", async () => {
    exec.mockResolvedValue({ stdout: INDEXED, stderr: "", code: 0 });
    expect(await checkIndexExists(exec, "/my/project")).toBe(true);
  });

  it("returns false when status output shows no index", async () => {
    exec.mockResolvedValue({ stdout: NOT_INDEXED, stderr: "", code: 0 });
    expect(await checkIndexExists(exec, "/my/project")).toBe(false);
  });

  it("returns false when colgrep status exits non-zero", async () => {
    exec.mockResolvedValue({ stdout: "", stderr: "boom", code: 1 });
    expect(await checkIndexExists(exec, "/my/project")).toBe(false);
  });

  it("returns false when exec throws", async () => {
    exec.mockRejectedValue(new Error("spawn failed"));
    expect(await checkIndexExists(exec, "/my/project")).toBe(false);
  });
});
