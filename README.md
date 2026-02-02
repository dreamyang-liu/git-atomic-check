# git-fission

<p align="center">
  <img src="logo.svg" alt="git-fission logo" width="400"/>
</p>

<p align="center">
  <strong>Split large git commits into atomic pieces using AI</strong><br>
  <em>Like nuclear fission — a neutron hits a heavy nucleus and splits it into smaller, more stable fragments.</em>
</p>

---

## What is git-fission?

`git-fission` analyzes your git commits and helps you split large, non-atomic commits into smaller, focused pieces. It uses AI (Claude via AWS Bedrock) to understand the semantic meaning of your changes and suggest logical splits.

A commit is considered **atomic** if it:
- Does **one thing** (single logical change)
- Is **reasonably small** (not too many files/lines)
- Has **related changes** (files in same area)
- Has a **clear, descriptive commit message**

## Installation

```bash
# Clone the repository
git clone https://github.com/dreamyang-liu/git-fission.git
cd git-fission

# Install dependencies
npm install

# Build
npm run build

# Link globally (optional)
npm link
# or
ln -s "$(pwd)/dist/index.js" ~/.local/bin/git-fission
```

## Usage

### Check the last unpushed commit

```bash
git-fission
```

### Split a commit

```bash
# Hunk-level splitting (default, faster & more stable)
git-fission --split HEAD

# Line-level splitting (experimental, finer granularity)
git-fission --split HEAD -L

# Preview without executing
git-fission --split HEAD --dry-run

# With custom instruction
git-fission --split HEAD -i "Keep test files in a separate commit"

# Debug mode
git-fission --split HEAD -L --debug --dry-run

# Use a specific model
git-fission --split HEAD -m us.anthropic.claude-opus-4-5-20251101-v1:0
```

## How it works

```
                                              ·
                                         ◦
                                    ·  ◦
                               ◦              ⬤━━━━▶
        ╭─────────╮      ·
        │ ◉  ◉  ◉ │   ◦          ⬤━━━━━━━▶
●━━━━▶  │ ◉  ◉  ◉ │
        │ ◉  ◉  ◉ │   ◦          ⬤━━━━━━━▶
        ╰─────────╯      ·
                               ◦              ⬤━━━━▶
                                    ◦  ·
                                         ◦
                                              ·

                        ⚛  git-fission
                  Split commits into atomic pieces
```

1. **Neutron (your command)** hits the nucleus (your large commit)
2. **Fission occurs** — AI analyzes and splits the diff into logical pieces
3. **Fragments fly out** — multiple atomic commits are created
4. **Chain reaction** — cleaner git history!

## Example

Before:
```
abc1234 feat: Add user auth, API endpoints, database models, and tests
```

After running `git-fission --split abc1234`:
```
def5678 feat(auth): Add user authentication middleware
ghi9012 feat(api): Add user CRUD endpoints
jkl3456 feat(db): Add User and Session models
mno7890 test: Add user authentication tests
```

## Options

| Option | Description |
|--------|-------------|
| `-v, --verbose` | Verbose output |
| `-m, --model <id>` | Bedrock model ID (default: claude-sonnet-4) |
| `--split <commit>` | Split a commit (hunk-level, fast & stable) |
| `-L, --line-level` | Use line-level splitting (experimental) |
| `--dry-run` | Preview split without executing |
| `--debug` | Write intermediate results to `.git-fission-debug/` |
| `-i, --instruction` | Custom instruction for LLM |
| `-h, --help` | Show help |

## Environment Variables

| Variable | Description |
|----------|-------------|
| `AWS_BEARER_TOKEN_BEDROCK` | Bearer token for Bedrock API |
| `AWS_REGION` | AWS region (default: `us-west-2`) |
| `GIT_FISSION_MODEL` | Default model |

## Available Models

| Model | Description |
|-------|-------------|
| `us.anthropic.claude-sonnet-4-20250514-v1:0` | Default (recommended) |
| `us.anthropic.claude-3-5-haiku-20241022-v1:0` | Faster, less accurate |
| `us.anthropic.claude-opus-4-5-20251101-v1:0` | Most capable |

## Features

- **LLM Analysis**: Deep semantic analysis using AWS Bedrock Claude models
- **Auto-Split**: Automatically split large commits into atomic ones
- **Hunk-Level Splitting**: Fast & stable, splits at diff hunk boundaries (default)
- **Line-Level Splitting**: Experimental, splits individual lines within the same hunk (`-L`)
- **Custom Instructions**: Guide the LLM with custom splitting rules
- **Debug Mode**: Inspect intermediate results for troubleshooting

## How Splitting Works

### Hunk-Level (Default) — Fast & Stable

Operates at the **hunk level**. A hunk is a contiguous block of changes in a diff (the sections starting with `@@`). The AI analyzes each hunk and classifies them into logical groups.

**Pros**: Fast (single LLM call), reliable patch generation
**Cons**: Cannot split changes within the same hunk

```
Original commit with 3 hunks in file.ts:
┌─────────────────────────────────┐
│ @@ -10,5 +10,8 @@  ← Hunk 1    │
│ @@ -50,3 +53,6 @@  ← Hunk 2    │
│ @@ -100,4 +106,4 @@ ← Hunk 3   │
└─────────────────────────────────┘
           ↓ git-fission
┌─────────────┐  ┌─────────────┐
│ Commit A    │  │ Commit B    │
│ Hunk 1 + 3  │  │ Hunk 2      │
└─────────────┘  └─────────────┘
```

### Line-Level (`-L` flag) — Experimental

Operates at the **line level**, allowing changes within the same hunk to be split into different commits.

**Pros**: Finer granularity, can split interleaved changes
**Cons**: Slower (multiple LLM calls), may produce invalid patches

Uses a 4-phase pipeline:

```
┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
│  Phase 1        │     │  Phase 2        │     │  Phase 3        │     │  Phase 4        │
│  Plan Commits   │ ──▶ │  Classify Lines │ ──▶ │  Extract Lines  │ ──▶ │  Build Patches  │
│  (LLM)          │     │  (LLM per hunk) │     │  (Script)       │     │  (Script)       │
└─────────────────┘     └─────────────────┘     └─────────────────┘     └─────────────────┘
```

1. **Phase 1 (Plan)**: LLM reads the entire diff and decides how many commits to create
2. **Phase 2 (Classify)**: For each hunk, LLM decides which lines belong to which commit
3. **Phase 3 (Extract)**: Script extracts line content from original diff (no LLM generation)
4. **Phase 4 (Assemble)**: Script builds patches, handling cross-commit dependencies

**Key Design**: LLM only makes decisions (which lines go where), script handles all diff generation. This avoids LLM formatting errors.

```
Same hunk, different commits:
┌─────────────────────────────────┐
│ @@ -10,5 +10,12 @@              │
│  context line                   │
│ +import { auth } from './auth'  │ ← Commit A
│ +import { cache } from './cache'│ ← Commit B
│  context line                   │
│ +function login() { ... }       │ ← Commit A
│ +function initCache() { ... }   │ ← Commit B
└─────────────────────────────────┘
           ↓ git-fission -L
┌─────────────┐  ┌─────────────┐
│ Commit A    │  │ Commit B    │
│ auth import │  │ cache import│
│ login()     │  │ initCache() │
└─────────────┘  └─────────────┘
```

### Debug Mode

Use `--debug` to write intermediate results to `.git-fission-debug/<commit-hash>/`:

```
.git-fission-debug/abc1234/
├── 00-original.diff           # Original diff
├── 01-plan.json               # Phase 1: Commit plan from LLM
├── 02-hunks.json              # Parsed hunks
├── 03-classifications.json    # Phase 2: Line classifications
├── 04-extracted.json          # Phase 3: Extracted line ranges
├── 05-patch-1-commit_1.patch  # Phase 4: Generated patches
├── 05-patch-2-commit_2.patch
└── 05-patches-summary.json
```

## Requirements

- Node.js 18+
- AWS credentials configured
- Git repository

## License

MIT
