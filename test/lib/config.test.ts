import { unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_CONFIG,
  EXTENSION_ID,
  getGlobalConfigPath,
  getProjectConfigPath,
  loadConfig,
  normalizeConfig,
  type ColGrepConfig,
} from "#src/lib/config";

function expectedConfig(overrides: {
  indexOnStartup?: boolean;
  guard?: Partial<ColGrepConfig["guard"]>;
  agent?: Partial<ColGrepConfig["agent"]>;
  concurrency?: Partial<ColGrepConfig["concurrency"]>;
  indexing?: Partial<ColGrepConfig["indexing"]>;
} = {}): ColGrepConfig {
  return {
    indexOnStartup: overrides.indexOnStartup ?? true,
    guard: { ...DEFAULT_CONFIG.guard, ...overrides.guard },
    agent: { ...DEFAULT_CONFIG.agent, ...overrides.agent },
    concurrency: { ...DEFAULT_CONFIG.concurrency, ...overrides.concurrency },
    indexing: { ...DEFAULT_CONFIG.indexing, ...overrides.indexing },
  };
}

describe("getGlobalConfigPath", () => {
  it("constructs the expected global path", () => {
    expect(getGlobalConfigPath("/home/user/.pi")).toBe(
      `/home/user/.pi/extensions/${EXTENSION_ID}/config.json`,
    );
  });
});

describe("getProjectConfigPath", () => {
  it("constructs the expected project path", () => {
    expect(getProjectConfigPath("/my/project")).toBe(
      `/my/project/.pi/extensions/${EXTENSION_ID}/config.json`,
    );
  });
});

describe("normalizeConfig", () => {
  it("returns empty config for non-object input", () => {
    expect(normalizeConfig(null)).toEqual({});
    expect(normalizeConfig("string")).toEqual({});
    expect(normalizeConfig(42)).toEqual({});
    expect(normalizeConfig([])).toEqual({});
  });

  it("returns empty config when nothing is present", () => {
    expect(normalizeConfig({})).toEqual({});
  });

  it("accepts a boolean indexOnStartup", () => {
    expect(normalizeConfig({ indexOnStartup: true })).toEqual({
      indexOnStartup: true,
    });
    expect(normalizeConfig({ indexOnStartup: false })).toEqual({
      indexOnStartup: false,
    });
  });

  it("ignores non-boolean indexOnStartup values", () => {
    expect(normalizeConfig({ indexOnStartup: "yes" })).toEqual({});
    expect(normalizeConfig({ indexOnStartup: 1 })).toEqual({});
    expect(normalizeConfig({ indexOnStartup: null })).toEqual({});
  });

  it("accepts a valid guard section", () => {
    expect(
      normalizeConfig({ guard: { mode: "strict", allowGitGrep: false } }),
    ).toEqual({ guard: { mode: "strict", allowGitGrep: false } });
  });

  it("drops invalid guard fields", () => {
    expect(normalizeConfig({ guard: { mode: "nope" } })).toEqual({});
    expect(normalizeConfig({ guard: { allowGitGrep: "yes" } })).toEqual({});
    expect(normalizeConfig({ guard: "strict" })).toEqual({});
  });

  it("accepts a valid agent section", () => {
    expect(
      normalizeConfig({
        agent: { enabled: false, timeoutMs: 120_000, maxConcurrent: 2 },
      }),
    ).toEqual({ agent: { enabled: false, timeoutMs: 120_000, maxConcurrent: 2 } });
  });

  it("accepts a valid concurrency section and clamps values", () => {
    expect(
      normalizeConfig({
        concurrency: { searchMax: 3, agentMax: 1, initMax: 1, waitMs: 30_000 },
      }),
    ).toEqual({
      concurrency: { searchMax: 3, agentMax: 1, initMax: 1, waitMs: 30_000 },
    });
    expect(normalizeConfig({ concurrency: { searchMax: 99 } })).toEqual({
      concurrency: { searchMax: 16 },
    });
    expect(normalizeConfig({ concurrency: { waitMs: 10 } })).toEqual({});
    expect(
      normalizeConfig({ concurrency: { initTimeoutMs: 1_200_000 } }),
    ).toEqual({ concurrency: { initTimeoutMs: 1_200_000 } });
    expect(normalizeConfig({ concurrency: { initTimeoutMs: 100 } })).toEqual(
      {},
    );
  });

  it("accepts an indexing section", () => {
    expect(normalizeConfig({ indexing: { maxFiles: 5_000 } })).toEqual({
      indexing: { maxFiles: 5_000 },
    });
    expect(normalizeConfig({ indexing: { maxFiles: 0 } })).toEqual({
      indexing: { maxFiles: 0 },
    });
    expect(normalizeConfig({ indexing: { maxFiles: -1 } })).toEqual({});
    expect(normalizeConfig({ indexing: { maxFiles: "lots" } })).toEqual({});
  });

  it("clamps agent values and drops invalid ones", () => {
    expect(normalizeConfig({ agent: { timeoutMs: 100 } })).toEqual({});
    expect(normalizeConfig({ agent: { maxConcurrent: 0 } })).toEqual({});
    expect(normalizeConfig({ agent: { maxConcurrent: 99 } })).toEqual({
      agent: { maxConcurrent: 8 },
    });
    expect(normalizeConfig({ agent: { enabled: "yes" } })).toEqual({});
  });

  it("ignores unknown keys", () => {
    expect(
      normalizeConfig({ indexOnStartup: false, unknown: true }),
    ).toEqual({ indexOnStartup: false });
  });
});

describe("loadConfig", () => {
  const tmpFiles: string[] = [];

  function writeTmp(content: string): string {
    const path = join(
      tmpdir(),
      `pi-colgrep-test-${Date.now()}-${Math.random()}.json`,
    );
    writeFileSync(path, content);
    tmpFiles.push(path);
    return path;
  }

  afterEach(() => {
    for (const f of tmpFiles) {
      try {
        unlinkSync(f);
      } catch {}
    }
    tmpFiles.length = 0;
  });

  it("returns defaults when both files are missing", () => {
    expect(
      loadConfig({
        globalConfigPath: "/nonexistent/global.json",
        projectConfigPath: "/nonexistent/project.json",
      }),
    ).toEqual(expectedConfig());
  });

  it("honors an explicit indexOnStartup: false from the global file", () => {
    const global = writeTmp(JSON.stringify({ indexOnStartup: false }));
    expect(
      loadConfig({
        globalConfigPath: global,
        projectConfigPath: "/nonexistent/project.json",
      }),
    ).toEqual(expectedConfig({ indexOnStartup: false }));
  });

  it("lets the project file override the global file", () => {
    const global = writeTmp(JSON.stringify({ indexOnStartup: true }));
    const project = writeTmp(JSON.stringify({ indexOnStartup: false }));
    expect(
      loadConfig({ globalConfigPath: global, projectConfigPath: project }),
    ).toEqual(expectedConfig({ indexOnStartup: false }));
  });

  it("merges guard sections field by field", () => {
    const global = writeTmp(
      JSON.stringify({ guard: { mode: "strict", allowGitGrep: false } }),
    );
    const project = writeTmp(JSON.stringify({ guard: { mode: "off" } }));
    expect(
      loadConfig({ globalConfigPath: global, projectConfigPath: project }),
    ).toEqual(
      expectedConfig({ guard: { mode: "off", allowGitGrep: false } }),
    );
  });

  it("merges agent sections field by field", () => {
    const global = writeTmp(
      JSON.stringify({ agent: { enabled: false, maxConcurrent: 3 } }),
    );
    const project = writeTmp(JSON.stringify({ agent: { timeoutMs: 60_000 } }));
    expect(
      loadConfig({ globalConfigPath: global, projectConfigPath: project }),
    ).toEqual(
      expectedConfig({
        agent: { enabled: false, maxConcurrent: 3, timeoutMs: 60_000 },
      }),
    );
  });

  it("merges concurrency sections field by field", () => {
    const global = writeTmp(JSON.stringify({ concurrency: { searchMax: 4 } }));
    const project = writeTmp(
      JSON.stringify({ concurrency: { agentMax: 2, waitMs: 10_000 } }),
    );
    expect(
      loadConfig({ globalConfigPath: global, projectConfigPath: project }),
    ).toEqual(
      expectedConfig({
        concurrency: { searchMax: 4, agentMax: 2, waitMs: 10_000 },
      }),
    );
  });

  it("warns and uses defaults when a file contains malformed JSON", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const global = writeTmp("not valid json {{{");
    expect(
      loadConfig({
        globalConfigPath: global,
        projectConfigPath: "/nonexistent/project.json",
      }),
    ).toEqual(expectedConfig());
    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls[0]?.[0]).toContain("[pi-colgrep]");
    warn.mockRestore();
  });
});
