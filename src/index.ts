#!/usr/bin/env node
/**
 * git-atomic-check: Check if unpushed commits are atomic/self-contained.
 * 
 * A commit is considered atomic if it:
 * 1. Does one thing (single logical change)
 * 2. Is reasonably small (not too many files/lines)
 * 3. Has related changes (files in same area)
 * 4. Has a clear, descriptive commit message
 */

import { spawnSync } from 'child_process';
import { BedrockRuntimeClient, ConverseCommand } from '@aws-sdk/client-bedrock-runtime';

// Colors
const c = {
  green: '\x1b[92m',
  yellow: '\x1b[93m',
  red: '\x1b[91m',
  blue: '\x1b[94m',
  cyan: '\x1b[96m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  reset: '\x1b[0m',
};

const LOGO = `
${c.cyan}   ⚛️  git-atomic-check${c.reset}
${c.dim}  ╭─────────────────────╮
  │  ✓ One thing only   │
  │  ✓ Small & focused  │
  │  ✓ Clean history    │
  ╰─────────────────────╯${c.reset}
`;

// Config
const DEFAULT_MODEL = 'us.anthropic.claude-3-5-haiku-20241022-v1:0';
const SPLIT_MODEL = 'us.anthropic.claude-sonnet-4-20250514-v1:0';

const THRESHOLDS = {
  normal: { maxFiles: 10, maxInsertions: 300, maxDeletions: 300, maxDirs: 3, minMsgLen: 10 },
  strict: { maxFiles: 5, maxInsertions: 100, maxDeletions: 100, maxDirs: 2, minMsgLen: 20 },
};

// Types
interface CommitInfo {
  hash: string;
  shortHash: string;
  message: string;
  author: string;
  filesChanged: number;
  insertions: number;
  deletions: number;
  files: string[];
  diff?: string;
}

interface LLMAnalysis {
  isAtomic: boolean;
  confidence: number;
  reasoning: string;
  concerns: string[];
  splitSuggestion?: string;
}

interface AtomicityReport {
  commit: CommitInfo;
  isAtomic: boolean;
  score: number;
  issues: string[];
  warnings: string[];
  suggestions: string[];
  llmAnalysis?: LLMAnalysis;
}

interface SplitPlan {
  reasoning: string;
  splits: Array<{
    message: string;
    diff: string;  // The actual unified diff for this commit
    description: string;
  }>;
}

// Git helpers
function runGit(args: string[]): { ok: boolean; output: string } {
  const result = spawnSync('git', args, {
    encoding: 'utf-8',
    maxBuffer: 10 * 1024 * 1024, // 10MB buffer for large diffs
  });

  if (result.status === 0) {
    return { ok: true, output: (result.stdout || '').trim() };
  } else {
    const errorMsg = result.stderr || result.error?.message || 'Unknown error';
    return { ok: false, output: errorMsg.toString().trim() };
  }
}

function getUnpushedCommits(n?: number): string[] {
  const { ok: branchOk, output: branch } = runGit(['rev-parse', '--abbrev-ref', 'HEAD']);
  if (!branchOk) return [];

  let tracking = '';
  const { ok: trackOk, output: trackBranch } = runGit(['rev-parse', '--abbrev-ref', `${branch}@{upstream}`]);
  
  if (trackOk) {
    tracking = trackBranch;
  } else {
    for (const def of ['origin/main', 'origin/master']) {
      const { ok } = runGit(['rev-parse', def]);
      if (ok) { tracking = def; break; }
    }
    if (!tracking) return [];
  }

  const cmd = ['rev-list', `${tracking}..HEAD`];
  if (n) cmd.push('-n', String(n));
  
  const { ok, output } = runGit(cmd);
  if (!ok || !output) return [];
  return output.split('\n').filter(Boolean);
}

function getCommitInfo(hash: string, includeDiff: boolean | 'full' = false): CommitInfo | null {
  const { ok, output } = runGit(['show', hash, '--format=%H%n%h%n%s%n%an', '--stat', '--stat-width=1000']);
  if (!ok) return null;
  const lines = output.split('\n');
  if (lines.length < 4) return null;

  const [fullHash, shortHash, message, author] = lines;
  const files: string[] = [];
  let insertions = 0, deletions = 0;

  for (const line of lines.slice(5)) {
    if (!line.trim()) continue;
    const fileMatch = line.match(/^\s*(.+?)\s*\|\s*(\d+)/);
    if (fileMatch) files.push(fileMatch[1].trim());
    const insMatch = line.match(/(\d+) insertion/);
    if (insMatch) insertions = parseInt(insMatch[1]);
    const delMatch = line.match(/(\d+) deletion/);
    if (delMatch) deletions = parseInt(delMatch[1]);
  }

  let diff = '';
  if (includeDiff) {
    const { ok: diffOk, output: diffOut } = runGit(['show', hash, '--format=', '-p']);
    if (diffOk && diffOut) {
      const maxDiff = includeDiff === 'full' ? 200000 : 8000;
      if (includeDiff === 'full' && diffOut.length > maxDiff) {
        console.error(`  ${c.red}Error: Diff is too large (${Math.round(diffOut.length / 1024)}KB > 200KB limit)${c.reset}`);
        console.error(`  ${c.yellow}Please split this commit manually into smaller chunks first.${c.reset}`);
        console.error(`  ${c.dim}Tip: Use 'git reset HEAD~1' to unstage, then create smaller commits.${c.reset}`);
        return null;
      }
      diff = diffOut.length > maxDiff ? diffOut.slice(0, maxDiff) + '\n... (truncated)' : diffOut;
    } else {
      console.error(`  ${c.yellow}Warning: Failed to get diff (ok=${diffOk})${c.reset}`);
      if (diffOut) console.error(`  ${c.dim}Error: ${diffOut}${c.reset}`);
    }
  }

  return { hash: fullHash, shortHash, message, author, filesChanged: files.length, insertions, deletions, files, diff };
}

// Analysis
function analyzeFileRelatedness(files: string[]): { score: number; issues: string[] } {
  if (files.length <= 1) return { score: 1, issues: [] };

  const dirs = new Set(files.map(f => f.split('/').slice(0, -1).join('/') || '.'));
  const exts = new Set(files.map(f => f.split('.').pop() || ''));
  
  const issues: string[] = [];
  if (dirs.size > 3) issues.push(`Changes span ${dirs.size} directories`);
  
  const dirScore = Math.max(0, 1 - (dirs.size - 1) * 0.15);
  const extScore = Math.max(0, 1 - (exts.size - 1) * 0.1);
  
  return { score: dirScore * 0.7 + extScore * 0.3, issues };
}

function analyzeMessage(message: string): { score: number; issues: string[]; suggestions: string[] } {
  const issues: string[] = [];
  const suggestions: string[] = [];
  let score = 0.5;

  if (message.length < 10) { issues.push('Commit message too short'); score -= 0.3; }
  else if (message.length >= 20) score += 0.1;

  const goodPrefixes = [
    /^(feat|fix|docs|style|refactor|test|chore|perf|ci|build|revert)(\(.+\))?:/i,
    /^(Add|Fix|Update|Remove|Refactor|Implement|Improve|Clean)/i,
  ];
  if (goodPrefixes.some(p => p.test(message))) score += 0.2;
  else suggestions.push('Consider using conventional commit format');

  const badPatterns = [/^(WIP|wip)/i, /^(fix|update|change)$/i, /^.{1,5}$/];
  if (badPatterns.some(p => p.test(message))) { issues.push('Commit message is vague or WIP'); score -= 0.2; }

  return { score: Math.max(0, Math.min(1, score)), issues, suggestions };
}

// LLM
async function callBedrock(prompt: string, model: string, maxTokens = 1024): Promise<string | null> {
  const bearerToken = process.env.AWS_BEARER_TOKEN_BEDROCK;
  const region = process.env.AWS_REGION || 'us-west-2';

  if (bearerToken) {
    // Use bearer token via fetch
    const endpoint = `https://bedrock-runtime.${region}.amazonaws.com/model/${model}/converse`;
    const body = JSON.stringify({
      messages: [{ role: 'user', content: [{ text: prompt }] }],
      inferenceConfig: { maxTokens, temperature: 0.1 },
      anthropic_beta: ['context-1m-2025-08-07']
    });

    try {
      const resp = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${bearerToken}` },
        body,
      });
      const data = await resp.json() as any;
      return data.output?.message?.content?.[0]?.text || null;
    } catch (e) {
      return null;
    }
  } else {
    // Use AWS SDK
    const client = new BedrockRuntimeClient({ region });
    try {
      const resp = await client.send(new ConverseCommand({
        modelId: model,
        messages: [{ role: 'user', content: [{ text: prompt }] }],
        inferenceConfig: { maxTokens, temperature: 0.1 },
      }));
      return (resp.output?.message?.content?.[0] as any)?.text || null;
    } catch (e) {
      return null;
    }
  }
}

async function analyzeWithLLM(commit: CommitInfo, model: string): Promise<LLMAnalysis | null> {
  const filesSum = commit.files.slice(0, 20).map(f => `  - ${f}`).join('\n');
  const prompt = `Analyze this git commit and determine if it is ATOMIC (does exactly one logical thing).

**Commit Message:** ${commit.message}
**Stats:** ${commit.filesChanged} files changed, +${commit.insertions}/-${commit.deletions} lines
**Files Changed:**
${filesSum}

**Diff (may be truncated):**
\`\`\`
${commit.diff || '(diff not available)'}
\`\`\`

Respond in JSON format:
{
  "is_atomic": true/false,
  "confidence": 0.0-1.0,
  "reasoning": "Brief explanation",
  "concerns": ["list of concerns if not atomic"],
  "split_suggestion": "How to split, or null if atomic"
}

Only output the JSON.`;

  const response = await callBedrock(prompt, model);
  if (!response) return null;

  try {
    const match = response.match(/\{[\s\S]*\}/);
    if (!match) return null;
    const result = JSON.parse(match[0]);
    return {
      isAtomic: result.is_atomic,
      confidence: result.confidence,
      reasoning: result.reasoning,
      concerns: result.concerns || [],
      splitSuggestion: result.split_suggestion,
    };
  } catch { return null; }
}

async function generateSplitPlan(commit: CommitInfo, model: string, previousErrors: string[] = []): Promise<SplitPlan | null> {
  const errorFeedback = previousErrors.length > 0
    ? `\n\n**IMPORTANT - Previous attempt had these errors, please fix them:**\n${previousErrors.map(e => `- ${e}`).join('\n')}\n`
    : '';

  const prompt = `You are a git expert. Split this commit's diff into multiple atomic commits.

**Original Commit Message:** ${commit.message}

**Full Diff:**
\`\`\`diff
${commit.diff || '(diff not available)'}
\`\`\`
${errorFeedback}
Split this into 2-5 atomic commits. For each commit, output the EXACT unified diff format that can be applied with \`git apply\`.

CRITICAL RULES:
1. Each split must contain a valid unified diff (starting with "diff --git")
2. The diffs must be complete - include all headers (diff --git, index, ---, +++)
3. Every hunk from the original diff must appear in exactly ONE split
4. Do not modify the diff content, just partition it
5. Hunk headers (@@ -X,Y +A,B @@) must have ACCURATE line counts:
   - Y = number of lines starting with '-' or ' ' (context) in the hunk
   - B = number of lines starting with '+' or ' ' (context) in the hunk
6. Each diff must end with a newline

Respond in JSON format:
{
  "reasoning": "Brief explanation of how you're splitting this",
  "splits": [
    {
      "message": "feat(auth): Add login endpoint",
      "description": "What this commit does",
      "diff": "diff --git a/file.ts b/file.ts\\nindex abc..def 100644\\n--- a/file.ts\\n+++ b/file.ts\\n@@ -1,3 +1,4 @@\\n+new line\\n existing"
    }
  ]
}

IMPORTANT: In the JSON, escape newlines as \\n in the diff field.
Only output the JSON.`;

  const response = await callBedrock(prompt, model, 32768);
  console.log(response);
  if (!response) return null;

  try {
    const match = response.match(/\{[\s\S]*\}/);
    if (!match) return null;
    return JSON.parse(match[0]);
  } catch { return null; }
}

// Main check
async function checkCommitAtomicity(commit: CommitInfo, strict: boolean, useLLM: boolean, model: string): Promise<AtomicityReport> {
  const th = strict ? THRESHOLDS.strict : THRESHOLDS.normal;
  const issues: string[] = [];
  const warnings: string[] = [];
  const suggestions: string[] = [];
  const scores: number[] = [];

  // File count
  if (commit.filesChanged > th.maxFiles) {
    issues.push(`Too many files: ${commit.filesChanged} (max: ${th.maxFiles})`);
    scores.push(Math.max(0, 1 - (commit.filesChanged - th.maxFiles) / th.maxFiles));
  } else scores.push(1);

  // Line count
  const totalLines = commit.insertions + commit.deletions;
  const maxLines = th.maxInsertions + th.maxDeletions;
  if (totalLines > maxLines) {
    issues.push(`Too many lines: +${commit.insertions}/-${commit.deletions} (max: ${maxLines})`);
    scores.push(Math.max(0, 1 - (totalLines - maxLines) / maxLines));
  } else scores.push(1);

  // File relatedness
  const { score: relScore, issues: relIssues } = analyzeFileRelatedness(commit.files);
  issues.push(...relIssues);
  scores.push(relScore);

  // Message quality
  const { score: msgScore, issues: msgIssues, suggestions: msgSuggestions } = analyzeMessage(commit.message);
  issues.push(...msgIssues);
  suggestions.push(...msgSuggestions);
  scores.push(msgScore);

  // LLM analysis
  let llmAnalysis: LLMAnalysis | undefined;
  if (useLLM) {
    process.stdout.write(`  ${c.dim}Analyzing with LLM...${c.reset}`);
    llmAnalysis = await analyzeWithLLM(commit, model) || undefined;
    process.stdout.write('\r' + ' '.repeat(40) + '\r');
    
    if (llmAnalysis) {
      const llmScore = llmAnalysis.isAtomic ? 1 : 0.3;
      scores.push(llmScore * llmAnalysis.confidence);
      if (!llmAnalysis.isAtomic) {
        issues.push(...llmAnalysis.concerns);
        if (llmAnalysis.splitSuggestion) suggestions.push(`LLM: ${llmAnalysis.splitSuggestion}`);
      }
    }
  }

  const finalScore = (scores.reduce((a, b) => a + b, 0) / scores.length) * 100;
  const isAtomic = useLLM && llmAnalysis 
    ? llmAnalysis.isAtomic && llmAnalysis.confidence > 0.6 && issues.length <= 2
    : issues.length === 0 && finalScore >= 70;

  return { commit, isAtomic, score: finalScore, issues, warnings, suggestions, llmAnalysis };
}

function printReport(report: AtomicityReport, verbose: boolean) {
  const { commit } = report;
  const status = report.isAtomic ? `${c.green}✓ ATOMIC${c.reset}` : `${c.red}✗ NOT ATOMIC${c.reset}`;
  
  console.log(`\n${c.bold}Commit ${c.blue}${commit.shortHash}${c.reset} ${status} (score: ${report.score.toFixed(0)}/100)`);
  console.log(`  ${commit.message.slice(0, 60)}${commit.message.length > 60 ? '...' : ''}`);
  console.log(`  ${commit.filesChanged} files, +${commit.insertions}/-${commit.deletions} lines`);

  if (report.llmAnalysis) {
    const conf = report.llmAnalysis.confidence;
    const confColor = conf > 0.8 ? c.green : conf > 0.5 ? c.yellow : c.red;
    console.log(`\n  ${c.cyan}🤖 LLM Analysis:${c.reset} (confidence: ${confColor}${(conf * 100).toFixed(0)}%${c.reset})`);
    console.log(`     ${report.llmAnalysis.reasoning}`);
  }

  if (report.issues.length) {
    console.log(`\n  ${c.red}Issues:${c.reset}`);
    report.issues.forEach(i => console.log(`    • ${i}`));
  }

  if (report.warnings.length) {
    console.log(`\n  ${c.yellow}Warnings:${c.reset}`);
    report.warnings.forEach(w => console.log(`    • ${w}`));
  }

  if (report.suggestions.length && (verbose || !report.isAtomic)) {
    console.log(`\n  ${c.blue}Suggestions:${c.reset}`);
    report.suggestions.forEach(s => console.log(`    ${s}`));
  }

  if (verbose && commit.files.length) {
    console.log(`\n  Files:`);
    commit.files.slice(0, 10).forEach(f => console.log(`    • ${f}`));
    if (commit.files.length > 10) console.log(`    ... and ${commit.files.length - 10} more`);
  }
}

/**
 * Validate and fix common issues with a patch
 * Returns { valid: boolean, fixed: string, errors: string[], warnings: string[] }
 */
function validateAndFixPatch(diff: string, index: number): { valid: boolean; fixed: string; errors: string[]; warnings: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];
  let fixed = diff;

  // Fix 1: Unescape literal \n that should be newlines (common LLM issue)
  if (fixed.includes('\\n') && !fixed.includes('\n')) {
    fixed = fixed.replace(/\\n/g, '\n');
  }

  // Fix 2: Ensure trailing newline
  if (!fixed.endsWith('\n')) {
    fixed += '\n';
  }

  // Fix 3: Remove any leading/trailing whitespace on the whole patch
  fixed = fixed.trim() + '\n';

  // Validation checks
  const lines = fixed.split('\n');

  // Check 1: Must start with "diff --git"
  if (!lines[0]?.startsWith('diff --git')) {
    errors.push(`Patch ${index + 1}: Missing "diff --git" header`);
  }

  // Check 2: Must have --- and +++ lines
  const hasMinusLine = lines.some(l => l.startsWith('--- '));
  const hasPlusLine = lines.some(l => l.startsWith('+++ '));
  if (!hasMinusLine || !hasPlusLine) {
    errors.push(`Patch ${index + 1}: Missing --- or +++ file headers`);
  }

  // Check 3: Must have at least one hunk header (@@ ... @@)
  const hasHunk = lines.some(l => l.startsWith('@@') && l.includes('@@', 2));
  if (!hasHunk) {
    errors.push(`Patch ${index + 1}: Missing hunk header (@@ ... @@)`);
  }

  // Note: We skip strict hunk line count validation here.
  // Off-by-one mismatches are common due to "\ No newline at end of file" markers
  // and context line handling. Let git apply --check do the authoritative validation.

  return { valid: errors.length === 0, fixed, errors, warnings };
}

async function executeSplit(commit: CommitInfo, plan: SplitPlan, dryRun: boolean): Promise<boolean> {
  const fs = await import('fs');
  const path = await import('path');
  const os = await import('os');

  console.log(`\n${c.bold}Split Plan for ${commit.shortHash}:${c.reset}`);
  console.log(`  ${c.dim}${plan.reasoning}${c.reset}\n`);

  // Preview splits
  plan.splits.forEach((split, i) => {
    const diffLines = split.diff.split('\n').length;
    console.log(`  ${c.cyan}${i + 1}.${c.reset} ${split.message}`);
    console.log(`     ${c.dim}${split.description} (${diffLines} lines of diff)${c.reset}`);
  });

  if (dryRun) {
    console.log(`\n${c.yellow}Dry run - no changes made.${c.reset}`);
    // Show diff previews
    plan.splits.forEach((split, i) => {
      console.log(`\n${c.bold}--- Patch ${i + 1}: ${split.message} ---${c.reset}`);
      console.log(c.dim + split.diff.slice(0, 500) + (split.diff.length > 500 ? '\n...(truncated)' : '') + c.reset);
    });
    return true;
  }

  // Confirm
  process.stdout.write(`\n${c.yellow}This will hard reset commit ${commit.shortHash} and apply ${plan.splits.length} patches.${c.reset}\nContinue? [y/N] `);
  
  const readline = await import('readline');
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise<string>(resolve => rl.question('', resolve));
  rl.close();
  
  if (answer.toLowerCase() !== 'y') {
    console.log('Aborted.');
    return false;
  }

  // Check for uncommitted changes
  const { output: status } = runGit(['status', '--porcelain']);
  if (status.trim()) {
    console.log(`${c.red}Error: Working directory has uncommitted changes.${c.reset}`);
    return false;
  }

  // Create temp directory for patches
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'git-atomic-split-'));
  console.log(`\n${c.dim}Saving patches to ${tmpDir}${c.reset}`);

  // Save patches to temp files
  const patchFiles: string[] = [];
  for (const [i, split] of plan.splits.entries()) {
    const patchFile = path.join(tmpDir, `${String(i + 1).padStart(2, '0')}-${split.message.slice(0, 30).replace(/[^a-zA-Z0-9]/g, '_')}.patch`);
    fs.writeFileSync(patchFile, split.diff);
    patchFiles.push(patchFile);
    console.log(`  ${c.dim}Saved patch ${i + 1}: ${path.basename(patchFile)}${c.reset}`);
  }

  // Hard reset to remove the commit
  console.log(`\n${c.dim}Hard resetting HEAD~1...${c.reset}`);
  const { ok: resetOk, output: resetOut } = runGit(['reset', '--hard', 'HEAD~1']);
  if (!resetOk) {
    console.log(`${c.red}Error: Failed to hard reset: ${resetOut}${c.reset}`);
    console.log(`${c.yellow}Patches saved in: ${tmpDir}${c.reset}`);
    return false;
  }

  // Apply patches one by one
  for (const [i, split] of plan.splits.entries()) {
    const patchFile = patchFiles[i];
    console.log(`\n${c.dim}Applying patch ${i + 1}/${plan.splits.length}: ${split.message.slice(0, 40)}...${c.reset}`);
    
    // Apply the patch
    const { ok: applyOk, output: applyOut } = runGit(['apply', '--check', patchFile]);
    if (!applyOk) {
      console.log(`${c.red}Patch ${i + 1} would fail to apply:${c.reset}`);
      console.log(`  ${applyOut}`);
      console.log(`\n${c.yellow}Patches saved in: ${tmpDir}${c.reset}`);
      console.log(`${c.yellow}You can manually apply remaining patches with: git apply <patch>${c.reset}`);
      return false;
    }

    // Actually apply it
    runGit(['apply', patchFile]);

    // Stage and commit
    runGit(['add', '-A']);
    const { ok: commitOk, output: commitOut } = runGit(['commit', '-m', split.message]);
    if (!commitOk) {
      console.log(`${c.red}Error creating commit ${i + 1}: ${commitOut}${c.reset}`);
      console.log(`${c.yellow}Patches saved in: ${tmpDir}${c.reset}`);
      return false;
    }
    console.log(`  ${c.green}✓${c.reset} Created: ${split.message.slice(0, 50)}`);
  }

  // Cleanup temp directory
  try {
    for (const f of fs.readdirSync(tmpDir)) fs.unlinkSync(path.join(tmpDir, f));
    fs.rmdirSync(tmpDir);
  } catch { /* ignore cleanup errors */ }

  console.log(`\n${c.green}✓ Successfully split into ${plan.splits.length} commits!${c.reset}`);
  
  const { output: log } = runGit(['log', '--oneline', `-${plan.splits.length + 1}`]);
  console.log(`\n${c.bold}New commits:${c.reset}`);
  log.split('\n').forEach(line => console.log(`  ${line}`));

  return true;
}

async function splitCommit(commitRef: string, model: string, dryRun: boolean, maxRetries = 2): Promise<boolean> {
  console.log(`${c.bold}Analyzing commit for split...${c.reset}`);

  const { ok, output: hash } = runGit(['rev-parse', commitRef]);
  if (!ok) {
    console.log(`${c.red}Error: Invalid commit reference${c.reset}`);
    return false;
  }

  const commit = getCommitInfo(hash.trim(), 'full');
  if (!commit) {
    console.log(`${c.red}Error: Could not get commit info${c.reset}`);
    return false;
  }

  console.log(`  Commit: ${commit.shortHash} - ${commit.message.slice(0, 50)}`);
  console.log(`  Files: ${commit.filesChanged}, Lines: +${commit.insertions}/-${commit.deletions}`);
  if (commit.diff?.includes('(truncated)')) {
    console.log(`  ${c.yellow}Note: Diff truncated to 200KB for analysis${c.reset}`);
  }

  let plan: SplitPlan | null = null;
  let lastErrors: string[] = [];

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (attempt > 0) {
      console.log(`\n${c.yellow}Retrying (attempt ${attempt + 1}/${maxRetries + 1})...${c.reset}`);
    }

    console.log(`\n${c.dim}Generating split plan with LLM...${c.reset}`);
    plan = await generateSplitPlan(commit, model, lastErrors);

    if (!plan) {
      console.log(`${c.red}Error: LLM failed to generate a split plan.${c.reset}`);
      continue;
    }

    if (plan.splits.length < 2) {
      console.log(`${c.green}LLM determined this commit is already atomic.${c.reset}`);
      return true;
    }

    // Validate patches before executing
    const validationResults = plan.splits.map((split, i) => validateAndFixPatch(split.diff, i));
    lastErrors = validationResults.flatMap(r => r.errors);

    if (lastErrors.length === 0) {
      // Apply fixes
      validationResults.forEach((result, i) => {
        plan!.splits[i].diff = result.fixed;
      });
      break;
    }

    console.log(`\n${c.yellow}Patch validation found issues:${c.reset}`);
    lastErrors.forEach(err => console.log(`  ${c.yellow}•${c.reset} ${err}`));

    if (attempt === maxRetries) {
      console.log(`\n${c.red}Failed to generate valid patches after ${maxRetries + 1} attempts.${c.reset}`);
      console.log(`${c.yellow}Try running with --dry-run to see the generated patches, or manually split the commit.${c.reset}`);
      return false;
    }
  }

  if (!plan) {
    console.log(`${c.red}Error: LLM failed to generate a split plan.${c.reset}`);
    console.log(`${c.yellow}This may be due to the diff being too large or complex.${c.reset}`);
    return false;
  }

  return executeSplit(commit, plan, dryRun);
}

// CLI
async function main() {
  const args = process.argv.slice(2);
  
  const flags = {
    n: undefined as number | undefined,
    strict: false,
    verbose: false,
    llm: false,
    model: process.env.GIT_ATOMIC_CHECK_MODEL || DEFAULT_MODEL,
    split: undefined as string | undefined,
    splitModel: process.env.GIT_ATOMIC_CHECK_SPLIT_MODEL || SPLIT_MODEL,
    dryRun: false,
    help: false,
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '-n' || arg === '--number') flags.n = parseInt(args[++i]);
    else if (arg === '--strict') flags.strict = true;
    else if (arg === '-v' || arg === '--verbose') flags.verbose = true;
    else if (arg === '--llm') flags.llm = true;
    else if (arg === '--model') flags.model = args[++i];
    else if (arg === '--split') flags.split = args[++i];
    else if (arg === '--split-model') flags.splitModel = args[++i];
    else if (arg === '--dry-run') flags.dryRun = true;
    else if (arg === '-h' || arg === '--help') flags.help = true;
  }

  if (flags.help) {
    console.log(`
${LOGO}
Usage: git-atomic-check [options]

Options:
  -n, --number <n>     Check last n unpushed commits
  --strict             Use stricter thresholds
  -v, --verbose        Verbose output
  --llm                Use LLM for semantic analysis
  --model <id>         Bedrock model ID
  --split <commit>     Split a commit into atomic commits
  --split-model <id>   Model for split analysis
  --dry-run            Preview split without executing
  -h, --help           Show help

Environment:
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
    const success = await splitCommit(flags.split, flags.splitModel, flags.dryRun);
    process.exit(success ? 0 : 1);
  }

  // Check mode
  const commits = getUnpushedCommits(flags.n);
  if (!commits.length) {
    console.log(`${c.green}✓ No unpushed commits to check${c.reset}`);
    process.exit(0);
  }

  console.log(LOGO);
  const mode = flags.llm ? `LLM (${flags.model.split('/').pop()})` : 'heuristic';
  console.log(`${c.bold}Checking ${commits.length} unpushed commit(s)...${c.reset} [${mode}]`);

  let allAtomic = true;
  let totalScore = 0;

  for (const hash of commits.reverse()) {
    const commit = getCommitInfo(hash, flags.llm);
    if (!commit) {
      console.log(`${c.yellow}Warning: Could not get info for ${hash.slice(0, 8)}${c.reset}`);
      continue;
    }

    const report = await checkCommitAtomicity(commit, flags.strict, flags.llm, flags.model);
    printReport(report, flags.verbose);

    if (!report.isAtomic) allAtomic = false;
    totalScore += report.score;
  }

  const avgScore = totalScore / commits.length;
  console.log(`\n${c.bold}${'─'.repeat(50)}${c.reset}`);

  if (allAtomic) {
    console.log(`${c.green}✓ All ${commits.length} commits are atomic!${c.reset} (avg score: ${avgScore.toFixed(0)}/100)`);
    process.exit(0);
  } else {
    console.log(`${c.red}✗ Some commits are not atomic${c.reset} (avg score: ${avgScore.toFixed(0)}/100)`);
    console.log(`\n${c.yellow}Tip: Use 'git-atomic-check --split HEAD' to split the last commit.${c.reset}`);
    process.exit(1);
  }
}

main().catch(console.error);
