import { describe, expect, it } from "vitest";
import { classifyBashCommand, type GuardOptions } from "#src/lib/guard";

const STRICT: GuardOptions = { mode: "strict", allowGitGrep: true };
const WARN: GuardOptions = { mode: "warn", allowGitGrep: true };
const OFF: GuardOptions = { mode: "off", allowGitGrep: true };

function decide(
  command: string,
  options: GuardOptions = STRICT,
  blockCounts = new Map<string, number>(),
) {
  return classifyBashCommand(command, options, blockCounts);
}

describe("classifyBashCommand — off mode", () => {
  it("allows everything when the guard is off", () => {
    expect(decide("rg pattern", OFF).action).toBe("allow");
    expect(decide("grep -rn pattern .", OFF).action).toBe("allow");
  });
});

describe("classifyBashCommand — blocks recursive repo searches", () => {
  it("blocks rg", () => {
    const decision = decide("rg handleError");
    expect(decision.action).toBe("block");
    expect(decision.reason).toContain('colgrep -e "handleError"');
  });

  it("blocks grep -r and grep -R", () => {
    expect(decide("grep -r handleError .").action).toBe("block");
    expect(decide("grep -R handleError .").action).toBe("block");
    expect(decide("grep --recursive handleError .").action).toBe("block");
  });

  it("blocks ag and ack", () => {
    expect(decide("ag handleError").action).toBe("block");
    expect(decide("ack handleError").action).toBe("block");
  });

  it("blocks with leading env assignments", () => {
    expect(decide("LC_ALL=C rg handleError").action).toBe("block");
  });

  it("extracts the pattern after value-taking flags", () => {
    const decision = decide('rg -g "*.ts" -t ts handleError');
    expect(decision.action).toBe("block");
    expect(decision.signature).toBe("rg handleError");
  });

  it("blocks piping from rg (the search itself is still a repo search)", () => {
    expect(decide("rg handleError | head -5").action).toBe("block");
  });
});

describe("classifyBashCommand — allow-list", () => {
  it("allows piped grep (stream filter)", () => {
    expect(decide("ps aux | grep node").action).toBe("allow");
    expect(decide("git log --oneline | grep fix").action).toBe("allow");
  });

  it("allows non-recursive grep", () => {
    expect(decide("grep handleError src/main.ts").action).toBe("allow");
    expect(decide("grep -n handleError README.md").action).toBe("allow");
  });

  it("allows git grep by default", () => {
    expect(decide("git grep handleError").action).toBe("allow");
  });

  it("blocks git grep when allowGitGrep is false", () => {
    expect(
      decide("git grep handleError", { mode: "strict", allowGitGrep: false })
        .action,
    ).toBe("block");
  });

  it("allows rg --files (file enumeration)", () => {
    expect(decide("rg --files").action).toBe("allow");
    expect(decide("rg --files src").action).toBe("allow");
  });

  it("allows searches reading from a redirect", () => {
    expect(decide("grep foo < input.txt").action).toBe("allow");
  });

  it("allows rg targeting a single explicit file", () => {
    expect(decide("rg handleError src/main.ts").action).toBe("allow");
  });

  it("allows --help/--version", () => {
    expect(decide("rg --help").action).toBe("allow");
    expect(decide("grep --version").action).toBe("allow");
  });

  it("allows unrelated commands", () => {
    expect(decide("npm test").action).toBe("allow");
    expect(decide("ls -la").action).toBe("allow");
    expect(decide("cat package.json").action).toBe("allow");
  });

  it("allows find (not a colgrep replacement)", () => {
    expect(decide("find . -name '*.ts'").action).toBe("allow");
  });
});

describe("classifyBashCommand — anti-loop safeguard", () => {
  it("strict mode: blocks twice, allows the third identical attempt", () => {
    const counts = new Map<string, number>();
    expect(decide("rg handleError", STRICT, counts).action).toBe("block");
    expect(decide("rg handleError", STRICT, counts).action).toBe("block");
    expect(decide("rg handleError", STRICT, counts).action).toBe("allow");
  });

  it("warn mode: blocks once then allows", () => {
    const counts = new Map<string, number>();
    expect(decide("rg handleError", WARN, counts).action).toBe("block");
    expect(decide("rg handleError", WARN, counts).action).toBe("allow");
  });

  it("tracks separate signatures independently", () => {
    const counts = new Map<string, number>();
    expect(decide("rg alpha", STRICT, counts).action).toBe("block");
    expect(decide("rg beta", STRICT, counts).action).toBe("block");
  });
});
