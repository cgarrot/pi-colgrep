# pi-colgrep

Pi extension that gives agents **ColGrep** code search and a **delegated code-localization agent** —
all local on the Mac.

Local fork of [`@gotgenes/pi-colgrep`](https://github.com/gotgenes/pi-packages/tree/main/packages/pi-colgrep) (MIT)
with three additions:

1. **`colgrep_agent` tool** — delegates open-ended localization ("where is X implemented/handled",
   bug reports, feature requests) to the local **colgrep-agent-2B** model (`colgrep --agent`).
   The model iteratively searches and reads the repository itself and returns `file:START-END`
   locations, so the calling model spends its context on understanding and patching instead of
   exploring.
2. **colgrep-first policy** — `colgrep` (semantic + exhaustive pattern search) is the DEFAULT search
   tool; `grep`/`rg` are last-resort exceptions (pipes, non-repo paths, no index). An optional
   `guard` can even block recursive bash greps and redirect them to colgrep.
3. **Extended config** — `guard` and `agent` sections (see below).

## Prerequisites

- **colgrep ≥ 1.8.5** on `PATH` (the `--agent` mode landed in 1.8.x):
  ```bash
  colgrep update          # if already installed
  # or: curl --proto '=https' --tlsv1.2 -LsSf https://github.com/lightonai/next-plaid/releases/latest/download/colgrep-installer.sh | sh
  ```
- **Agent model** (one-time, ~2.5 GB), for `colgrep_agent`:
  ```bash
  colgrep --install-agent
  ```
- Node.js ≥ 22.

## Install

```bash
pi install git:github.com/cgarrot/pi-colgrep
```

Or clone the repo and point Pi at the directory (`pi install ./pi-colgrep`, or add its path to the
`packages` list in `~/.pi/agent/settings.json`):

```json
{
  "packages": ["path/to/pi-colgrep"]
}
```

## Tools

### `colgrep` — default code search

Semantic / hybrid search over the auto-indexed repository. Complements nothing: it **is** the
default search tool.

| Parameter | CLI flag                 | Description                          |
| --------- | ------------------------ | ------------------------------------ |
| `query`   | positional               | Natural-language intent              |
| `regex`   | `-e`                     | Pattern pre-filter (exhaustive)      |
| `path`    | positional (after query) | Directory or file to search          |
| `glob`    | `--include`              | Include pattern (e.g. `*.ts`)        |
| `limit`   | `-k`                     | Max results                          |
| `context` | `-n`                     | Context lines                        |

At least one of `query` or `regex` is required.

### `colgrep_agent` — delegated code localization

| Parameter  | Description                                             |
| ---------- | ------------------------------------------------------- |
| `question` | Open-ended question ("why does export crash on empty")  |
| `path`     | Optional scope (directory or file)                      |

Returns `file:START-END` locations plus a one-line meta summary (turns · searches · seconds).
Typically 20–90 s; runs on the local GPU (Metal). One run at a time per session by default.

## colgrep-first policy

- `colgrep` is preferred for any in-repo search — by intent (`query`) or exact pattern (`regex`).
- `colgrep_agent` is the escalation for open-ended localization.
- `grep`/`rg` remain for pipes, outside-the-repo paths, and index-less situations.

The optional **guard** (`guard.mode`: `off` code default | `warn` recommended | `strict`) blocks recursive bash greps
(`rg`, `grep -r`, `ag`, `ack`) with a ready-to-paste colgrep equivalent. Allow-list: piped usage,
non-recursive grep, `git grep` (configurable), `rg --files`, redirects, single-file targets.
Anti-loop: a repeated search signature is blocked at most twice, then passes.

Adoption is measured machine-wide: every session appends counters to
`<agentDir>/extensions/pi-colgrep/stats.jsonl` (append-only, safe for concurrent
mesh/subagent sessions) and `/colgrep-stats` shows totals, last-7-day counts and
the **colgrep share** (searches vs recursive greps). Detection runs even when the
guard is `off` — measuring never blocks anything.

## Configuration

Config files (project overrides global, per section):

| Scope   | Path                                              |
| ------- | ------------------------------------------------- |
| Global  | `<agentDir>/extensions/pi-colgrep/config.json`    |
| Project | `<cwd>/.pi/extensions/pi-colgrep/config.json`     |

```jsonc
{
  "indexOnStartup": true,          // background index build on session start
  "guard": {
    "mode": "warn",               // "off" (code default) | "warn" (recommended) | "strict"
    "allowGitGrep": true
  },
  "agent": {
    "enabled": true,               // expose the colgrep_agent tool
    "timeoutMs": 300000,           // per-run timeout
    "maxConcurrent": 1             // GPU-bound; keep at 1
  }
}
```

## Commands

- `/colgrep-reindex` — build/refresh the semantic index for the current directory.
- `/colgrep-stats` — show adoption counters (searches, agent runs, recursive greps, blocked/allowed, colgrep share).
- `/colgrep-agent-install` — download the colgrep-agent-2B model (~2.5 GB, one-time).

## Indexing lifecycle

- On session start the index is built in the **background** (`colgrep init`), never blocking startup.
- After each successful `write`/`edit`, a debounced reindex is scheduled — only when an index
  already exists for the directory.
- A real search auto-indexes on demand regardless.

## Credits & license

- Base package: [`@gotgenes/pi-colgrep`](https://github.com/gotgenes/pi-packages) v2.0.0, MIT,
  © Chris Lasher — substantial portions reused.
- Skill adapted from the ColGrep SKILL.md, © 2026 Raphael Sourty / LightOn (Apache-2.0), see
  `THIRD_PARTY_LICENSES/`.
- ColGrep / colgrep-agent-2B: [lightonai/next-plaid](https://github.com/lightonai/next-plaid) and
  [lightonai/colgrep-agent-2B](https://huggingface.co/lightonai/colgrep-agent-2B).
- License: MIT (see `LICENSE`).
