/**
 * Extension configuration loading.
 *
 * Config files live at:
 *  - Global:  <agentDir>/extensions/pi-colgrep/config.json
 *  - Project: <cwd>/.pi/extensions/pi-colgrep/config.json
 *
 * Project config takes precedence over global (per section: a project `guard`
 * object overrides only the guard keys it sets). A missing file is silent; a
 * malformed file warns to stderr and falls back to defaults.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { GuardMode } from "./guard";

export const EXTENSION_ID = "pi-colgrep";

export interface GuardConfig {
  /** "off" (default): the agent decides, steered by prompts. "warn"/"strict": block recursive bash greps. */
  mode: GuardMode;
  /** Allow `git grep` without blocking (default true). */
  allowGitGrep: boolean;
}

export interface AgentConfig {
  /** Expose the colgrep_agent tool (default true). */
  enabled: boolean;
  /** Exec timeout for one agent run, ms (default 300 000). */
  timeoutMs: number;
  /** Max concurrent agent runs per session (default 1; GPU-bound). */
  maxConcurrent: number;
}

export interface ConcurrencyConfig {
  /** Max concurrent colgrep searches machine-wide (default 2). */
  searchMax: number;
  /** Max concurrent colgrep_agent runs machine-wide (default 1, ~4 GB each). */
  agentMax: number;
  /** Max concurrent index builds machine-wide (default 1, CPU-heavy). */
  initMax: number;
  /** How long an operation waits for a free slot before giving up (default 60 s). */
  waitMs: number;
}

export interface ColGrepConfig {
  /** Whether to build the semantic index in the background on session start. */
  indexOnStartup: boolean;
  /** colgrep-first guard for bash searches. */
  guard: GuardConfig;
  /** colgrep_agent (delegated code localization) settings. */
  agent: AgentConfig;
  /** Machine-wide concurrency limits (shared across all Pi sessions). */
  concurrency: ConcurrencyConfig;
}

export type ColGrepConfigPartial = {
  indexOnStartup?: boolean;
  guard?: Partial<GuardConfig>;
  agent?: Partial<AgentConfig>;
  concurrency?: Partial<ConcurrencyConfig>;
};

export const DEFAULT_CONFIG: ColGrepConfig = {
  indexOnStartup: true,
  guard: {
    mode: "off",
    allowGitGrep: true,
  },
  agent: {
    enabled: true,
    timeoutMs: 300_000,
    maxConcurrent: 1,
  },
  concurrency: {
    searchMax: 2,
    agentMax: 1,
    initMax: 1,
    waitMs: 60_000,
  },
};

export function getGlobalConfigPath(agentDir: string): string {
  return join(agentDir, "extensions", EXTENSION_ID, "config.json");
}

export function getProjectConfigPath(cwd: string): string {
  return join(cwd, ".pi", "extensions", EXTENSION_ID, "config.json");
}

/** Drop fields that don't match the expected shape. Garbage becomes absent. */
export function normalizeConfig(raw: unknown): ColGrepConfigPartial {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const record = raw as Record<string, unknown>;
  const config: ColGrepConfigPartial = {};

  if (typeof record.indexOnStartup === "boolean") {
    config.indexOnStartup = record.indexOnStartup;
  }

  const guard = record.guard;
  if (guard && typeof guard === "object" && !Array.isArray(guard)) {
    const g = guard as Record<string, unknown>;
    const normalized: Partial<GuardConfig> = {};
    if (g.mode === "off" || g.mode === "warn" || g.mode === "strict") {
      normalized.mode = g.mode;
    }
    if (typeof g.allowGitGrep === "boolean") {
      normalized.allowGitGrep = g.allowGitGrep;
    }
    if (Object.keys(normalized).length > 0) config.guard = normalized;
  }

  const agent = record.agent;
  if (agent && typeof agent === "object" && !Array.isArray(agent)) {
    const a = agent as Record<string, unknown>;
    const normalized: Partial<AgentConfig> = {};
    if (typeof a.enabled === "boolean") {
      normalized.enabled = a.enabled;
    }
    if (
      typeof a.timeoutMs === "number" &&
      Number.isFinite(a.timeoutMs) &&
      a.timeoutMs >= 5_000
    ) {
      normalized.timeoutMs = Math.floor(a.timeoutMs);
    }
    if (
      typeof a.maxConcurrent === "number" &&
      Number.isFinite(a.maxConcurrent) &&
      a.maxConcurrent >= 1
    ) {
      normalized.maxConcurrent = Math.min(8, Math.floor(a.maxConcurrent));
    }
    if (Object.keys(normalized).length > 0) config.agent = normalized;
  }

  const concurrency = record.concurrency;
  if (concurrency && typeof concurrency === "object" && !Array.isArray(concurrency)) {
    const c = concurrency as Record<string, unknown>;
    const normalized: Partial<ConcurrencyConfig> = {};
    const bounded = (value: unknown, min: number, max: number) =>
      typeof value === "number" && Number.isFinite(value) && value >= min
        ? Math.min(max, Math.floor(value))
        : undefined;
    const searchMax = bounded(c.searchMax, 1, 16);
    const agentMax = bounded(c.agentMax, 1, 8);
    const initMax = bounded(c.initMax, 1, 8);
    const waitMs = bounded(c.waitMs, 1_000, 600_000);
    if (searchMax !== undefined) normalized.searchMax = searchMax;
    if (agentMax !== undefined) normalized.agentMax = agentMax;
    if (initMax !== undefined) normalized.initMax = initMax;
    if (waitMs !== undefined) normalized.waitMs = waitMs;
    if (Object.keys(normalized).length > 0) config.concurrency = normalized;
  }

  return config;
}

function loadSingleConfig(path: string): ColGrepConfigPartial {
  if (!existsSync(path)) return {};
  try {
    const raw = JSON.parse(readFileSync(path, "utf-8")) as unknown;
    return normalizeConfig(raw);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    console.warn(
      `[pi-colgrep] Ignoring malformed config at ${path}: ${reason}`,
    );
    return {};
  }
}

/** Load merged config: defaults <- global <- project. */
export function loadConfig(options: {
  globalConfigPath: string;
  projectConfigPath: string;
}): ColGrepConfig {
  const global = loadSingleConfig(options.globalConfigPath);
  const project = loadSingleConfig(options.projectConfigPath);
  return {
    indexOnStartup:
      project.indexOnStartup ?? global.indexOnStartup ?? DEFAULT_CONFIG.indexOnStartup,
    guard: {
      ...DEFAULT_CONFIG.guard,
      ...global.guard,
      ...project.guard,
    },
    agent: {
      ...DEFAULT_CONFIG.agent,
      ...global.agent,
      ...project.agent,
    },
    concurrency: {
      ...DEFAULT_CONFIG.concurrency,
      ...global.concurrency,
      ...project.concurrency,
    },
  };
}
