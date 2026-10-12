---
name: colgrep
description: |
  colgrep-first code search policy: colgrep (semantic + pattern) is the DEFAULT way to find
  code; grep/rg are last-resort exceptions. Also covers when to escalate to colgrep_agent —
  the local 2B code-localization agent that answers "where is X implemented/handled" questions
  and returns file:line locations. Load before exploring unfamiliar code.
---

<!-- Adapted from ColGrep SKILL.md (https://github.com/lightonai/next-plaid)
     Copyright 2026, Raphael Sourty, LightOn — Apache-2.0
     See THIRD_PARTY_LICENSES/next-plaid-LICENSE.Apache-2.0.txt
     Fork notice: colgrep-first policy + colgrep_agent section added by the local pi-colgrep fork -->

# Code Search with ColGrep — colgrep-first

ColGrep provides semantic and hybrid code search using ColBERT embeddings and tree-sitter parsing.
**It is the default search tool.** `grep`/`rg` remain available only for the exceptions listed below.

## Why Load This Skill

The default habit is to reach for `grep`/`rg` and burn many turns on keyword guessing.
This project replaces that habit: colgrep finds code by *intent*, its pattern mode (`-e`) is
**exhaustive**, and `colgrep_agent` can localize code for you when you don't know the vocabulary yet.
Load this skill before exploring, not after.

## Decision Table (colgrep-first)

| Task | Tool |
| ---- | ---- |
| Any code search — exploration, lookups, "find where…" | **`colgrep`** (tool) |
| Exact pattern / symbol / "all usages of X" | **`colgrep`** with `regex` (exhaustive, `-e`) |
| Open-ended localization: bug report, feature request, "how does X work", "where is X handled" | **`colgrep_agent`** (tool) |
| Filtering another command's output (`ps aux \| grep …`) | `grep`/`rg` via bash — allowed |
| Searching outside the repository / no index possible (huge logs, `/tmp`, system paths) | `grep`/`rg` via bash — allowed |
| Find files by name | `find`/`rg --files` |

Rules of thumb:
- If you are about to type `rg`/`grep -r` **inside the repo**, stop and use `colgrep` instead.
- If you don't know the exact words, don't guess keywords — either describe the intent to `colgrep`
  or delegate to `colgrep_agent`.
- After a search, read only the returned locations; don't re-derive them with more greps.

## Quick Reference — colgrep CLI

```bash
# Semantic search (find code by intent)
colgrep "error handling for database connections" -k 10
colgrep "authentication middleware" -k 25          # More results for exploration
colgrep "query" ./src/parser                       # Search in specific directory
colgrep "query" ./src/main.ts                      # Search in specific file

# Pattern search (exhaustive, grep replacement inside the repo)
colgrep -e "handleError"                           # All matches, hybrid-ranked
colgrep -e "async function" --include="*.ts"       # Pattern + file filter
colgrep -e "pattern" -k 500                        # Large k = effectively unlimited

# Hybrid search (text + semantic)
colgrep -e "handleError" "error handling patterns"
colgrep -e "regex" -E "semantic query"             # Extended regex (ERE)
colgrep -e "literal[0]" -F "semantic query"        # Fixed string (no regex)
colgrep -e "test" -w "testing utilities"           # Whole word match

# Output options
colgrep -l "query"                                 # List files only
colgrep -n 6 "query"                               # Show 6 context lines
colgrep --json "query"                             # JSON output
```

### Tool parameter mapping (`colgrep` tool)

| Tool parameter | CLI flag                 | Example            |
| -------------- | ------------------------ | ------------------ |
| `query`        | positional               | `"error handling"` |
| `regex`        | `-e`                     | `"handleError"`    |
| `path`         | positional (after query) | `"./src"`          |
| `glob`         | `--include`              | `"*.ts"`           |
| `limit`        | `-k`                     | `25`               |
| `context`      | `-n`                     | `6`                |

## colgrep_agent — delegated code localization

`colgrep_agent` runs a **local 2B model** (`colgrep --agent`) that iteratively searches the
repository and reads files (read-only), then returns precise `file:START-END` locations.

**Use it when** the question is open-ended and you don't know the vocabulary yet:
- "why does the export crash on empty files"
- "where is the retry policy configured"
- "how is session expiry handled"
- a bug report or feature request to localize

**Don't use it for** quick lookups a single `colgrep` call answers directly, and **never run the
same question twice** — read the returned locations instead.

What you get back:

```
src/lib/server.ts:103-118
src/lib/retry.ts:42-60

[colgrep_agent: 2 locations · 5 turns · 9 searches · 21.7s]
```

- Typical cost: **20–90 s** and a few thousand tokens of *its own* context — this is the point:
  it saves YOUR context.
- It runs on the local GPU; avoid launching several runs in parallel.
- After it returns: `read` the locations, then proceed with understanding/patching.

## Grep-Compatible Flags

| Flag            | Description                                   | Example                                      |
| --------------- | --------------------------------------------- | -------------------------------------------- |
| `-e <PATTERN>`  | Text pattern pre-filter                       | `colgrep -e "async" "concurrency"`           |
| `-E`            | Extended regex (ERE) for `-e`                 | `colgrep -e "async\|await" -E "concurrency"` |
| `-F`            | Fixed string (no regex) for `-e`              | `colgrep -e "foo[bar]" -F "query"`           |
| `-w`            | Whole word match for `-e`                     | `colgrep -e "test" -w "testing"`             |
| `-k, --results` | Number of results (tool: `limit`)             | `colgrep -k 20 "query"`                      |
| `-n, --lines`   | Context lines (tool: `context`)               | `colgrep -n 10 "query"`                      |
| `-l`            | List files only                               | `colgrep -l "authentication"`                |
| `--include`     | Include files matching pattern (tool: `glob`) | `colgrep --include="*.py" "query"`           |
| `--exclude`     | Exclude files matching pattern (CLI only)     | `colgrep --exclude="*.min.js" "query"`       |
| `--exclude-dir` | Exclude directories (CLI only)                | `colgrep --exclude-dir=node_modules "query"` |

Notes:

- `-F` takes precedence over `-E` (like grep). Default exclusions: `.git`, `node_modules`, `target`, `.venv`, `__pycache__`.
- Patterns are **exhaustive** (verified against `rg -l`): `-e` returns the same files as recursive grep.
- Non-code files (`.md`, docs) are indexed and searchable by default.

## Key Rules

1. **colgrep first.** For any in-repo search, colgrep is the default; `rg`/`grep -r` in the repo is the exception, not the reflex.
2. Use **intent** (`query`) when you don't know the wording; use **regex** when you do — pattern search is exhaustive.
3. **Escalate** to `colgrep_agent` for open-ended localization; **don't duplicate** its work afterwards.
4. Keep `grep` for pipes, outside-the-repo paths, and index-less situations.
5. Combine tools deliberately: `colgrep_agent` to locate → `read` → `edit`.
6. In large multi-project workspaces (e.g. `prototypes/*`), **scope searches to
   the specific project directory** (`path` parameter) instead of the whole
   workspace — first-time indexing of a workspace with hundreds of projects
   and dump folders is expensive; per-project indexes are fast.

## Need Help?

Run `colgrep --help` for complete documentation on all flags and options.
Agent-mode settings (`colgrep settings --agent-*`): turn budget, temperature, context, GPU layers, or an OpenAI-compatible endpoint.
