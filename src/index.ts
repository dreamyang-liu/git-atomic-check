#!/usr/bin/env node
/**
 * git-fission: Split large commits into atomic pieces using AI.
 *
 * Like nuclear fission - a neutron hits a heavy nucleus and splits it
 * into smaller, more stable fragments. This tool does the same for
 * your commits: analyze a large commit and split it into atomic pieces.
 */

import { c, LOGO, DEFAULT_MODELS, DEFAULT_PROVIDER } from './config.js';
import { parseModelString } from './llm.js';
import type { LLMProvider } from './types.js';
import { runGit, getUnpushedCommits, getCommitInfo } from './git.js';
import { checkCommitAtomicity, printReport } from './check.js';
import { splitCommit } from './split.js';

async function main() {
  const args = process.argv.slice(2);

  // Determine default provider from env
  const envProvider = process.env.GIT_FISSION_PROVIDER as LLMProvider | undefined;
  const defaultProvider: LLMProvider = envProvider && ['bedrock', 'anthropic', 'openai', 'openrouter'].includes(envProvider)
    ? envProvider
    : DEFAULT_PROVIDER;

  const flags = {
    verbose: false,
    model: process.env.GIT_FISSION_MODEL || DEFAULT_MODELS[defaultProvider],
    provider: defaultProvider,
    split: undefined as string | undefined,
    dryRun: false,
    help: false,
    instruction: undefined as string | undefined,
    lineLevel: false,
    debug: false,
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '-v' || arg === '--verbose') flags.verbose = true;
    else if (arg === '--model' || arg === '-m') flags.model = args[++i];
    else if (arg === '--provider' || arg === '-p') {
      const p = args[++i] as LLMProvider;
      if (['bedrock', 'anthropic', 'openai', 'openrouter'].includes(p)) {
        flags.provider = p;
      }
    }
    else if (arg === '--split') flags.split = args[++i];
    else if (arg === '--dry-run') flags.dryRun = true;
    else if (arg === '-h' || arg === '--help') flags.help = true;
    else if (arg === '--instruction' || arg === '-i') flags.instruction = args[++i];
    else if (arg === '--line-level' || arg === '-L') flags.lineLevel = true;
    else if (arg === '--debug') flags.debug = true;
  }

  // Parse model string - supports "provider:model" format or just "model"
  const llmConfig = parseModelString(flags.model, flags.provider);

  if (flags.help) {
    console.log(`
${LOGO}
Usage: git-fission [options]

By default, checks the last unpushed commit for atomicity.
Use --split to split a non-atomic commit into smaller pieces.

Options:
  -v, --verbose        Verbose output
  -p, --provider <p>   LLM provider: bedrock, anthropic, openai, openrouter
  -m, --model <id>     Model ID (or use provider:model format)
  --split <commit>     Split a commit (hunk-level, fast & stable)
  -L, --line-level     Use line-level splitting (experimental)
  --dry-run            Preview split without executing
  --debug              Write intermediate results to .git-fission-debug/
  -i, --instruction    Custom instruction for the LLM
  -h, --help           Show help

Model format:
  --model claude-3-5-haiku-20241022           # Uses default provider
  --model anthropic:claude-3-5-sonnet-20241022  # Explicit provider
  --model openai:gpt-4o                       # OpenAI
  --model openrouter:anthropic/claude-3.5-haiku # OpenRouter

Environment:
  GIT_FISSION_PROVIDER       Default provider (bedrock, anthropic, openai, openrouter)
  GIT_FISSION_MODEL          Default model
  ANTHROPIC_API_KEY          API key for Anthropic
  OPENAI_API_KEY             API key for OpenAI
  OPENROUTER_API_KEY         API key for OpenRouter
  AWS_BEARER_TOKEN_BEDROCK   Bearer token for Bedrock
  AWS_REGION                 AWS region (default: us-west-2)
`);
    process.exit(0);
  }

  // Check if in git repo
  const { ok } = runGit(['rev-parse', '--git-dir']);
  if (!ok) {
    console.log(`${c.red}Error: Not a git repository${c.reset}`);
    process.exit(1);
  }

  // Split mode
  if (flags.split) {
    const success = await splitCommit(flags.split, llmConfig, flags.dryRun, flags.lineLevel, flags.instruction, flags.debug);
    process.exit(success ? 0 : 1);
  }

  // Check mode - only check the last unpushed commit
  const commits = getUnpushedCommits(1);
  if (!commits.length) {
    console.log(`${c.green}✓ No unpushed commits to check${c.reset}`);
    process.exit(0);
  }

  const hash = commits[0];
  const commit = getCommitInfo(hash, true);
  if (!commit) {
    console.log(`${c.red}Error: Could not get info for ${hash.slice(0, 8)}${c.reset}`);
    process.exit(1);
  }

  console.log(LOGO);
  console.log(`${c.bold}Checking last unpushed commit...${c.reset} [LLM: ${llmConfig.provider}:${llmConfig.model.split('/').pop()}]`);

  const report = await checkCommitAtomicity(commit, llmConfig);
  printReport(report, flags.verbose);

  console.log(`\n${c.bold}${'─'.repeat(50)}${c.reset}`);

  if (report.isAtomic) {
    console.log(`${c.green}✓ Commit is atomic!${c.reset} (score: ${report.score.toFixed(0)}/100)`);
    process.exit(0);
  } else {
    console.log(`${c.red}✗ Commit is not atomic${c.reset} (score: ${report.score.toFixed(0)}/100)`);
    console.log(`\n${c.yellow}Tip: Use 'git-fission --split HEAD' to split this commit.${c.reset}`);
    process.exit(1);
  }
}

main().catch(console.error);
