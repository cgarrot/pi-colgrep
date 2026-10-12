# Changelog

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
