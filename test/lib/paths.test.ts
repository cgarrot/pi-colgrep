import { homedir } from "node:os";
import { describe, expect, it } from "vitest";
import { isUnsafeIndexRoot, unsafeRootMessage } from "#src/lib/paths";

describe("isUnsafeIndexRoot", () => {
  it("flags the real home directory", () => {
    expect(isUnsafeIndexRoot(homedir())).toBe(true);
  });

  it("flags the home parent (e.g. /Users, /home) and the filesystem root", () => {
    const home = "/Users/alice";
    expect(isUnsafeIndexRoot("/Users", home)).toBe(true);
    expect(isUnsafeIndexRoot("/", home)).toBe(true);
  });

  it("allows project directories", () => {
    const home = "/Users/alice";
    expect(isUnsafeIndexRoot("/Users/alice/zob/zoma", home)).toBe(false);
    expect(isUnsafeIndexRoot("/tmp/repo", home)).toBe(false);
  });

  it("normalizes dot segments", () => {
    expect(isUnsafeIndexRoot("/Users/alice/../alice", "/Users/alice")).toBe(
      true,
    );
  });

  it("explains the refusal", () => {
    expect(unsafeRootMessage("/Users/alice")).toContain("home directory");
  });
});
