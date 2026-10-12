/**
 * colgrep-first guard for bash searches.
 *
 * Optional policy layer (default: `off` — the agent decides, steered by tool
 * descriptions and the skill). When enabled, recursive code searches issued
 * through `bash` (`rg`, `grep -r`, `ag`, `ack`, …) are blocked with an
 * actionable colgrep equivalent.
 *
 * Allow-list (never blocked):
 * - piped usage (`… | grep …`) — a stream filter, not a repository search;
 * - non-recursive `grep` (single file or stdin);
 * - `git grep` (configurable, default allowed);
 * - `rg --files` (file enumeration — colgrep is not a file finder);
 * - commands reading from a redirect (`grep … < file`);
 * - `--help` / `--version`.
 *
 * Anti-loop safeguard: a given search signature is blocked at most twice; the
 * third identical attempt passes, so an agent with a genuinely special case is
 * never hard-stuck.
 */
export type GuardMode = "off" | "warn" | "strict";

export interface GuardOptions {
  mode: GuardMode;
  allowGitGrep: boolean;
}

export interface GuardDecision {
  action: "allow" | "block";
  reason?: string;
  signature?: string;
  /** True when a recursive in-repo search was detected (even if allowed). */
  detected?: boolean;
}

const SEARCH_TOOLS = new Set(["rg", "grep", "ag", "ack", "ugrep", "pt"]);

/** Flags that take a value and must be skipped when locating the pattern. */
const VALUE_FLAGS = new Set([
  "-g",
  "--glob",
  "-t",
  "--type",
  "-e",
  "--regexp",
  "-f",
  "--file",
  "-m",
  "--max-count",
  "-A",
  "-B",
  "-C",
  "--context",
  "--max-depth",
  "-j",
  "--threads",
]);

const MAX_BLOCKS_PER_SIGNATURE = 2;

/**
 * Classify a bash command under the colgrep-first policy.
 *
 * `blockCounts` is a caller-owned map used for the anti-loop safeguard; pass
 * the same map across calls within a session.
 */
export function classifyBashCommand(
  command: string,
  options: GuardOptions,
  blockCounts: Map<string, number> = new Map(),
): GuardDecision {
  // When mode is "off" parsing still runs (adoption stats count recursive
  // greps) but nothing is blocked and no counters are mutated.
  const enforcing = options.mode !== "off";

  const segments = splitPipeline(command);
  for (const segment of segments) {
    if (segment.piped) {
      // Receives stdin from another process: a filter, not a search.
      continue;
    }

    const parsed = parseSearchCommand(segment.text);
    if (!parsed) continue;

    const { tool, tokens, gitGrep } = parsed;

    if (gitGrep && options.allowGitGrep) {
      return { action: "allow" };
    }

    if (tokens.some((t) => /^--help$|^--version$|^-V$/.test(t))) {
      return { action: "allow" };
    }

    if (tool === "rg" && tokens.includes("--files")) {
      // File enumeration is find territory, not colgrep's.
      return { action: "allow" };
    }

    if (tool === "grep" && !gitGrep && !isRecursiveGrep(tokens)) {
      // Non-recursive grep (single file / stdin) stays allowed.
      return { action: "allow" };
    }

    if (!gitGrep && segment.text.includes("<")) {
      // Reads from a redirect.
      return { action: "allow" };
    }

    if (!gitGrep && looksLikeSingleFileTarget(tokens)) {
      return { action: "allow" };
    }

    const pattern = extractPattern(tokens);
    const signature = `${tool} ${pattern}`;

    if (!enforcing) {
      return { action: "allow", detected: true, signature };
    }

    const timesBlocked = blockCounts.get(signature) ?? 0;
    const maxBlocks =
      options.mode === "warn" ? 1 : MAX_BLOCKS_PER_SIGNATURE;
    if (timesBlocked >= maxBlocks) {
      // Anti-loop: let the repeated attempt through.
      return { action: "allow", detected: true, signature };
    }

    blockCounts.set(signature, timesBlocked + 1);
    return {
      action: "block",
      detected: true,
      signature,
      reason: buildBlockReason(tool, pattern),
    };
  }

  return { action: "allow" };
}

interface Segment {
  text: string;
  /** True when the segment is fed by a pipe from the previous segment. */
  piped: boolean;
}

function splitPipeline(command: string): Segment[] {
  const segments: Segment[] = [];
  let current = "";
  let currentPiped = false;
  let i = 0;
  while (i < command.length) {
    const char = command[i];
    if (char === "|") {
      segments.push({ text: current, piped: currentPiped });
      current = "";
      currentPiped = true;
      i += command[i + 1] === "|" ? 2 : 1;
      continue;
    }
    if (char === ";") {
      segments.push({ text: current, piped: currentPiped });
      current = "";
      currentPiped = false;
      i += 1;
      continue;
    }
    if (char === "&" && command[i + 1] === "&") {
      segments.push({ text: current, piped: currentPiped });
      current = "";
      currentPiped = false;
      i += 2;
      continue;
    }
    if (char === "\\" && command[i + 1] === "\n") {
      current += " ";
      i += 2;
      continue;
    }
    current += char;
    i += 1;
  }
  segments.push({ text: current, piped: currentPiped });
  return segments.filter((segment) => segment.text.trim() !== "");
}

interface ParsedSearch {
  tool: string;
  /** Tokens after the tool name. */
  tokens: string[];
  /** True when invoked as `git grep`. */
  gitGrep: boolean;
}

function parseSearchCommand(segment: string): ParsedSearch | undefined {
  // Strip leading env assignments and common prefixes (sudo, command, time).
  const stripped = segment
    .trim()
    .replace(/^(?:\w+=\S+\s+)+/, "")
    .replace(/^(?:sudo|command|time|nohup)\s+/, "");

  const gitMatch = /^git\s+grep\b(.*)$/s.exec(stripped);
  if (gitMatch) {
    return { tool: "grep", tokens: tokenize(gitMatch[1]), gitGrep: true };
  }

  const match = /^(rg|grep|ag|ack|ugrep|pt)\b(.*)$/s.exec(stripped);
  if (!match) return undefined;

  const tool = match[1];
  if (!SEARCH_TOOLS.has(tool)) return undefined;

  return { tool, tokens: tokenize(match[2]), gitGrep: false };
}

/** Naive shell tokenizer: splits on whitespace, keeps quoted runs together. */
function tokenize(input: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: string | undefined;
  for (let i = 0; i < input.length; i += 1) {
    const char = input[i];
    if (quote) {
      if (char === quote) {
        quote = undefined;
      } else {
        current += char;
      }
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }
    if (/\s/.test(char)) {
      if (current !== "") {
        tokens.push(current);
        current = "";
      }
      continue;
    }
    current += char;
  }
  if (current !== "") tokens.push(current);
  return tokens;
}

function isRecursiveGrep(tokens: string[]): boolean {
  return tokens.some(
    (token) =>
      /^-[a-zA-Z]*[rR]/.test(token) ||
      token === "--recursive" ||
      token === "-d" ||
      token === "--directories",
  );
}

/** True when a non-flag token looks like an explicit file (has an extension). */
function looksLikeSingleFileTarget(tokens: string[]): boolean {
  const nonFlags = tokens.filter((t) => !t.startsWith("-"));
  // Drop the first non-flag (the pattern); a later file-like token means the
  // user targeted specific files rather than the whole tree.
  return nonFlags
    .slice(1)
    .some((t) => /\.[A-Za-z0-9]{1,8}$/.test(t) && !t.endsWith("/"));
}

function extractPattern(tokens: string[]): string {
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (token.startsWith("-")) {
      if (VALUE_FLAGS.has(token)) i += 1;
      continue;
    }
    return token;
  }
  return "";
}

function buildBlockReason(tool: string, pattern: string): string {
  const quoted = pattern === "" ? '"<pattern>"' : `"${pattern}"`;
  return [
    `Blocked by the colgrep-first guard: recursive ${tool} searches must go through colgrep in this session.`,
    `Use instead: colgrep -e ${quoted}   (exhaustive pattern search, semantic-ranked)`,
    `For intent queries: the colgrep tool, or colgrep ${quoted} for hybrid search.`,
    `Allowed without colgrep: pipes, single-file greps, git grep, rg --files.`,
  ].join("\n");
}
