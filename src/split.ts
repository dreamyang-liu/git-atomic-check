/**
 * Commit splitting functionality
 */

import { c } from './config.js';
import { runGit, getCommitInfo } from './git.js';
import { generateSplitPlan } from './llm.js';
import type { CommitInfo, SplitPlan } from './types.js';

export async function executeSplit(commit: CommitInfo, plan: SplitPlan, dryRun: boolean): Promise<boolean> {
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
  const readline = await import('readline');
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const prompt = `\n${c.yellow}This will hard reset commit ${commit.shortHash} and apply ${plan.splits.length} patches.${c.reset}\nContinue? [y/N] `;
  const answer = await new Promise<string>(resolve => rl.question(prompt, resolve));
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
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'git-fission-'));
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

export async function splitCommit(commitRef: string, model: string, dryRun: boolean, lineLevel: boolean = false, instruction?: string, debug?: boolean): Promise<boolean> {
  // Use line-level splitting if requested
  if (lineLevel) {
    const { splitCommitLineLevel } = await import('./line-split/index.js');
    return splitCommitLineLevel(commitRef, model, dryRun, instruction, debug);
  }

  console.log(`${c.bold}Analyzing commit for split...${c.reset}`);
  if (instruction) {
    console.log(`  ${c.cyan}Custom instruction: ${instruction.slice(0, 200)}${instruction.length > 200 ? '...' : ''}${c.reset}`);
  }

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
  if (commit.diff?.endsWith('(truncated)')) {
    console.log(`  ${c.yellow}Note: Diff truncated to 200KB for analysis${c.reset}`);
  }

  console.log(`\n${c.dim}Generating split plan with LLM...${c.reset}`);
  const plan = await generateSplitPlan(commit, model, instruction);

  if (!plan) {
    console.log(`${c.red}Error: LLM failed to generate a split plan.${c.reset}`);
    console.log(`${c.yellow}This may be due to the diff being too large or complex.${c.reset}`);
    return false;
  }

  if (plan.splits.length < 2) {
    console.log(`${c.green}LLM determined this commit is already atomic.${c.reset}`);
    return true;
  }

  return executeSplit(commit, plan, dryRun);
}
