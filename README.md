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
  },
  "concurrency": {
    "searchMax": 2,                // concurrent colgrep searches machine-wide
    "agentMax": 1,                 // concurrent agent runs machine-wide (~4 GB RAM each)
    "initMax": 1,                  // concurrent index builds machine-wide (CPU-heavy)
    "waitMs": 60000,               // how long an operation waits for a slot
    "initTimeoutMs": 900000        // per-build exec timeout (15 min)
  }
}
```

## Machine-wide concurrency protection

Pi sessions are independent processes — with a mesh swarm, dozens of agents can
run at once on one machine. Per-session counters cannot protect RAM/CPU, so the
extension enforces **machine-wide slots** through lock files shared by all
sessions (`<agentDir>/extensions/pi-colgrep/slots/`):

- **searches**: `concurrency.searchMax` (default 2) — each search loads the
  embedding model (~150 MB); bursts are queued (wait up to `waitMs`, then a
  clear "at capacity" error the agent can retry).
- **agent runs**: `concurrency.agentMax` (default 1) — the 2B GGUF costs
  ~4 GB RAM per run; parallel runs would swap-thrash the machine.
- **index builds**: `concurrency.initMax` (default 1) — parsing/embedding is
  CPU-heavy; concurrent builds queue, and a debounced post-edit reindex that
  cannot get a slot is skipped (searches auto-update the index anyway).

Stale locks self-heal: a lock whose owner process died (session crash) or is
older than 15 minutes is stolen, so a crashed agent can never wedge the machine.

**Corrupted-index self-heal.** A build interrupted mid-write (timeout, session
end, machine pressure) leaves a partial index and colgrep then fails with
`Index load failed: Failed to open metadata` on every session. The extension
detects that error (search and reindex paths), removes the corrupted index
directory — with a hard safety check that it lives under colgrep's own
`indices/` root — and rebuilds/retries once. Build timeouts are generous
(15 min by default, `concurrency.initTimeoutMs`) since first builds of large
projects legitimately take minutes and the machine-wide init slot already
prevents build stampedes.

## Commands

- `/colgrep-reindex` — build/refresh the semantic index for the current directory.
- `/colgrep-stats` — show adoption counters (searches, agent runs, recursive greps, blocked/allowed, colgrep share).
- `/colgrep-agent-install` — download the colgrep-agent-2B model (~2.5 GB, one-time).

## Indexing lifecycle

- On session start the index is built in the **background** — but only when the
  directory has **no index yet**; existing indexes are updated on demand by
  searches (modified files are detected automatically). This avoids reindex
  storms when several mesh/subagent sessions share a large directory.
- After each successful `write`/`edit`, a debounced reindex is scheduled — only
  when an index already exists for the directory.
- A real search auto-indexes on demand regardless. While an index build is in
  progress (own session or another agent's), the tool **waits or retries**
  (exponential backoff, up to 2 min) rather than failing and suggesting grep.
  Each search attempt is capped at **3 minutes** (runaway auto-index guard) —
  pathological directories (huge dump folders) cannot block a call forever.
- Large directories with volatile content (e.g. `.mesh/`, `**/dbg*` dumps)
  should be added to colgrep's `extra_ignore` in
  `~/Library/Application Support/colgrep/config.json`.

> **`extra_ignore` semantics (measured on colgrep 1.8.5)**: entries match
> **exact file/directory names** anywhere in the tree — **globs and substrings
> do not work** (`**/dbg*`, `*.pem`, `**/*secret*` are silently no-ops).
> Hidden files/dirs are skipped by default, and `.pem`/`.key`-style files are
> not indexed by colgrep's type filter anyway. Use plain names:
> `dbg2`, `wtest`, `node_modules`, `dist`, `build`.

## Credits & license

- Base package: [`@gotgenes/pi-colgrep`](https://github.com/gotgenes/pi-packages) v2.0.0, MIT,
  © Chris Lasher — substantial portions reused.
- Skill adapted from the ColGrep SKILL.md, © 2026 Raphael Sourty / LightOn (Apache-2.0), see
  `THIRD_PARTY_LICENSES/`.
- ColGrep / colgrep-agent-2B: [lightonai/next-plaid](https://github.com/lightonai/next-plaid) and
  [lightonai/colgrep-agent-2B](https://huggingface.co/lightonai/colgrep-agent-2B).
- License: MIT (see `LICENSE`).
