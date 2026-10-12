# Changelog

## 3.3.0 — index-build resilience

- Searches wait for the session's in-flight reindex instead of racing it
  (`waitForIndexIdle`), for both `colgrep` and `colgrep_agent`.
- Searches retry with exponential backoff (up to 2 min) while another process
  builds the index, instead of surfacing "rely on grep for now" — the error
  now tells the agent to retry colgrep, not to fall back to recursive grep.
- Startup indexing now runs only when no index exists for the directory
  (searches auto-update modified files), preventing reindex storms when
  several mesh/subagent sessions share one large directory.
- +8 tests (211 total).

## 3.2.0 — adoption enforcement & measurement

- **Guard detection mode**: recursive in-repo searches are now detected even
  when the guard is `off`, feeding adoption counters without ever blocking.
- **Adoption stats**: every session appends to a shared
  `stats.jsonl` (tool searches, agent runs, blocked/allowed recursive greps) —
  append-only JSONL so concurrent mesh/subagent sessions never race.
- **`/colgrep-stats`** command: totals, last-7-day counts and the colgrep
  share (colgrep searches vs recursive greps) for the whole machine.
- Recommendation: run the guard in `warn` mode (one nudge per pattern, then
  anti-loop pass-through) and watch the stats before deciding on `strict`.

## 3.1.0 — collapsed-view previews

- Collapsed tool results now show the first 3 returned lines plus a
  `(ctrl+o to expand)` hint, so operators see what a tool actually returned at
  a glance; `… +N more` marks longer lists and `(truncated)` marks capped output.
- `colgrep_agent` uses the same preview and now follows the upstream
  `lastComponent` render pattern.

## 3.0.0 — local fork

Based on `@gotgenes/pi-colgrep` v2.0.0 (MIT, © Chris Lasher). Added:

- **`colgrep_agent` tool** (`src/tools/colgrep_agent.ts`, `src/lib/agent.ts`):
  delegates open-ended code localization to the local colgrep-agent-2B model
  (`colgrep --agent --json`), returns `file:START-END` locations with a meta
  summary; fast offline model probe (HF cache), configurable timeout,
  per-session concurrency limiter.
- **colgrep-first guard** (`src/lib/guard.ts`): optional (`off` by default)
  blocking of recursive bash code searches (`rg`, `grep -r`, `ag`, `ack`) with
  an actionable colgrep equivalent; allow-list for pipes, non-recursive grep,
  `git grep`, `rg --files`, redirects, single-file targets; anti-loop safeguard.
- **Extended config**: `guard` (`mode`, `allowGitGrep`) and `agent`
  (`enabled`, `timeoutMs`, `maxConcurrent`) sections, merged per section
  between global and project files.
- **colgrep-first skill**: decision table inverted (colgrep is the default;
  grep/rg are exceptions) + `colgrep_agent` escalation guidance.
- **`/colgrep-agent-install`** command (one-time ~2.5 GB model download).
- Session-start agent-model probe with actionable notice when missing.

### Verification (2026-10-12)

- 182 unit tests across 12 files (`npm test`), TypeScript clean (`npm run check`).
- End-to-end smoke through Pi: `colgrep` returned a hit in 851 ms;
  `colgrep_agent` localized `src/retry.ts:4-5` in 6.8 s (4 turns) on the local
  GPU via the real `colgrep` 1.8.5 binary.
- Global load verified with the full local package stack (tools + skill
  registered, no loader warnings).
