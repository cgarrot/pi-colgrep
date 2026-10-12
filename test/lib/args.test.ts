import { describe, expect, it } from "vitest";
import { buildSearchArgs } from "#src/lib/args";

describe("buildSearchArgs", () => {
  it("always includes --json", () => {
    const args = buildSearchArgs({ query: "error handling" });
    expect(args).toContain("--json");
  });

  it("passes query as positional argument", () => {
    const args = buildSearchArgs({ query: "error handling" });
    expect(args).toContain("error handling");
  });

  it("passes regex via -e flag", () => {
    const args = buildSearchArgs({ regex: "async fn" });
    expect(args).toContain("-e");
    expect(args).toContain("async fn");
  });

  it("includes both query and regex when both provided", () => {
    const args = buildSearchArgs({ query: "error handling", regex: "panic!" });
    expect(args).toContain("error handling");
    expect(args).toContain("-e");
    expect(args).toContain("panic!");
  });

  it("passes path as positional argument after query", () => {
    const args = buildSearchArgs({ query: "auth", path: "./src" });
    expect(args).toContain("./src");
  });

  it("passes path with regex-only (no query)", () => {
    const args = buildSearchArgs({ regex: "fn.*Error", path: "./lib" });
    expect(args).toContain("./lib");
  });

  it("passes glob via --include flag", () => {
    const args = buildSearchArgs({ query: "parse config", glob: "*.ts" });
    expect(args).toContain("--include");
    expect(args).toContain("*.ts");
  });

  it("passes limit via -k flag", () => {
    const args = buildSearchArgs({ query: "auth", limit: 5 });
    expect(args).toContain("-k");
    expect(args).toContain("5");
  });

  it("passes context via -n flag", () => {
    const args = buildSearchArgs({ query: "auth", context: 3 });
    expect(args).toContain("-n");
    expect(args).toContain("3");
  });

  it("omits optional flags when not provided", () => {
    const args = buildSearchArgs({ query: "auth" });
    expect(args).not.toContain("-e");
    expect(args).not.toContain("--include");
    expect(args).not.toContain("-k");
    expect(args).not.toContain("-n");
  });

  it("places --json before positional arguments", () => {
    const args = buildSearchArgs({ query: "auth", path: "./src" });
    const jsonIdx = args.indexOf("--json");
    const queryIdx = args.indexOf("auth");
    expect(jsonIdx).toBeLessThan(queryIdx);
  });
});
