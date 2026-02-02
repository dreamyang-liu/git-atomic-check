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
# Split the last commit into atomic pieces
git-fission --split HEAD --model us.anthropic.claude-opus-4-5-20251101-v1:0
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
| `--split <commit>` | Split a commit into atomic commits (default: HEAD) |
| `-m, --model <id>` | Bedrock model ID (default: claude-sonnet-4) |
| `--dry-run` | Preview split without executing |
| `-h, --help` | Show help |

> **Note**: By default, git-fission checks only the last unpushed commit.

## Environment Variables

| Variable | Description |
|----------|-------------|
| `AWS_BEARER_TOKEN_BEDROCK` | Bearer token for Bedrock API |
| `AWS_REGION` | AWS region (default: `us-west-2`) |
| `GIT_FISSION_MODEL` | Default model |

## Available Models

| Model | Use Case |
|-------|----------|
| `us.anthropic.claude-3-5-haiku-20241022-v1:0` | Default for check (fast) |
| `us.anthropic.claude-sonnet-4-20250514-v1:0` | Default for split (accurate) |

## Features

- **LLM Analysis**: Deep semantic analysis using AWS Bedrock Claude models
- **Auto-Split**: Automatically split large commits into atomic ones
- **Hunk-Level Splitting**: Splits at diff hunk boundaries (contiguous blocks of changes)
- **Patch Validation**: Validates and auto-fixes common LLM patch generation issues
- **Retry Logic**: Automatically retries with feedback if patch generation fails

## How Splitting Works

git-fission operates at the **hunk level**. A hunk is a contiguous block of changes in a diff (the sections starting with `@@`). The AI analyzes each hunk and classifies them into logical groups, then creates separate commits for each group.



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

### Current Limitations






- **Hunk-level granularity**: If two logically separate changes are within the same hunk (close together in the file), they cannot be split apart
- Works best when different concerns are in different parts of the file

### Future Work


- **Line-level splitting**: Split individual lines within the same hunk into different commits (similar to `git add -p` interactive staging but automated)


## Requirements

- Node.js 18+
- AWS credentials configured
- Git repository

## License

MIT
