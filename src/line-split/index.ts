/**
 * Line-level commit splitting
 * Main entry point that orchestrates the 4-phase pipeline
 */

import * as fs from 'fs';
import * as path from 'path';
import { c } from '../config.js';
import { runGit, getCommitInfo, parseDiffIntoHunks } from '../git.js';
import type { CommitInfo, SplitPlan } from '../types.js';
import { generateCommitPlan } from './plan.js';
import { classifyAllHunks } from './classify.js';
import { extractChanges, validateExtraction } from './extract.js';
import { buildPatches, validatePatch } from './assemble.js';

/**
 * Write debug output to a file
 */
function writeDebugFile(debugDir: string, filename: string, content: string | object): void {
  const filePath = path.join(debugDir, filename);
  const data = typeof content === 'string' ? content : JSON.stringify(content, null, 2);
  fs.writeFileSync(filePath, data);
  console.log(`  ${c.dim}Debug: wrote ${filename}${c.reset}`);
}

/**
 * Execute line-level split
 * Returns a SplitPlan compatible with the existing executeSplit function
 */
export async function lineLevelSplit(
  commit: CommitInfo,
  model: string,
  instruction?: string,
  debugDir?: string
): Promise<SplitPlan | null> {
  if (!commit.diff) {
    console.error(`  ${c.red}Error: No diff available${c.reset}`);
    return null;
  }

  // Create debug directory if specified
  if (debugDir) {
    fs.mkdirSync(debugDir, { recursive: true });
    console.log(`  ${c.cyan}Debug output: ${debugDir}${c.reset}`);
    // Write original diff
    writeDebugFile(debugDir, '00-original.diff', commit.diff);
  }

  // Phase 1: Generate commit plan
  console.log(`  ${c.dim}Phase 1: Generating commit plan...${c.reset}`);
  const plan = await generateCommitPlan(commit, model, instruction);

  if (!plan) {
    console.error(`  ${c.red}Error: Failed to generate commit plan${c.reset}`);
    return null;
  }

  console.log(`  ${c.green}✓${c.reset} Planned ${plan.commits.length} commits`);
  for (const p of plan.commits) {
    console.log(`    ${c.dim}- ${p.id}: ${p.message}${c.reset}`);
  }

  // Debug: write plan
  if (debugDir) {
    writeDebugFile(debugDir, '01-plan.json', plan);
  }

  // If only one commit, it's already atomic
  if (plan.commits.length <= 1) {
    return {
      reasoning: plan.reasoning,
      splits: [],
    };
  }

  // Parse diff into hunks
  const files = parseDiffIntoHunks(commit.diff);
  const totalHunks = files.reduce((sum, f) => sum + f.hunks.length, 0);
  console.log(`\n  ${c.dim}Phase 2: Classifying ${totalHunks} hunks...${c.reset}`);

  // Debug: write parsed hunks
  if (debugDir) {
    writeDebugFile(debugDir, '02-hunks.json', files);
  }

  // Phase 2: Classify lines in each hunk
  const classifications = await classifyAllHunks(files, plan.commits, model);
  console.log(`  ${c.green}✓${c.reset} Classified all hunks`);

  // Debug: write classifications
  if (debugDir) {
    writeDebugFile(debugDir, '03-classifications.json', classifications);
  }

  // Phase 3: Extract changes
  console.log(`\n  ${c.dim}Phase 3: Extracting changes...${c.reset}`);
  const commitChanges = extractChanges(files, plan.commits, classifications);

  // Debug: write extracted changes
  if (debugDir) {
    writeDebugFile(debugDir, '04-extracted.json', commitChanges);
  }

  // Validate extraction
  const validation = validateExtraction(files, commitChanges);
  if (!validation.valid) {
    console.error(`  ${c.yellow}Warning: Extraction validation issues:${c.reset}`);
    for (const err of validation.errors) {
      console.error(`    ${c.dim}- ${err}${c.reset}`);
    }
  }

  // Log changes per commit
  for (const cc of commitChanges) {
    let addCount = 0, delCount = 0;
    for (const fc of cc.fileChanges) {
      for (const range of fc.ranges) {
        if (range.type === '+') addCount += range.lines.length;
        else delCount += range.lines.length;
      }
    }
    console.log(`  ${c.dim}  ${cc.commitId}: +${addCount}/-${delCount} lines${c.reset}`);
  }
  console.log(`  ${c.green}✓${c.reset} Extracted all changes`);

  // Phase 4: Assemble patches
  console.log(`\n  ${c.dim}Phase 4: Assembling patches...${c.reset}`);
  const patches = buildPatches(files, commitChanges, commit.hash);

  // Debug: write each patch
  if (debugDir) {
    for (let i = 0; i < patches.length; i++) {
      const patch = patches[i];
      const filename = `05-patch-${i + 1}-${patch.commitId}.patch`;
      writeDebugFile(debugDir, filename, patch.patch);
    }
    // Also write patches summary
    writeDebugFile(debugDir, '05-patches-summary.json', patches.map(p => ({
      commitId: p.commitId,
      message: p.message,
      description: p.description,
      patchLength: p.patch.length,
    })));
  }

  // Validate patches
  let allValid = true;
  for (const patch of patches) {
    const patchValidation = validatePatch(patch.patch);
    if (!patchValidation.valid) {
      console.error(`  ${c.red}✗ Invalid patch for ${patch.commitId}: ${patchValidation.error}${c.reset}`);
      allValid = false;
    }
  }

  if (!allValid) {
    console.error(`  ${c.red}Error: Some patches are invalid${c.reset}`);
    // Continue anyway - let git apply --check catch actual issues
  }

  console.log(`  ${c.green}✓${c.reset} Assembled ${patches.length} patches`);

  // Convert to SplitPlan format
  return {
    reasoning: plan.reasoning,
    splits: patches.map(p => ({
      message: p.message,
      description: p.description,
      diff: p.patch,
    })),
  };
}

/**
 * Main entry point for line-level splitting
 */
export async function splitCommitLineLevel(
  commitRef: string,
  model: string,
  dryRun: boolean,
  instruction?: string,
  debug?: boolean
): Promise<boolean> {
  // Import executeSplit from split.ts to avoid circular dependency
  const { executeSplit } = await import('../split.js');

  console.log(`${c.bold}Analyzing commit for line-level split...${c.reset}`);
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

  // Setup debug directory if debug mode is enabled
  const debugDir = debug ? `.git-fission-debug/${commit.shortHash}` : undefined;

  const plan = await lineLevelSplit(commit, model, instruction, debugDir);

  if (!plan) {
    console.log(`${c.red}Error: Failed to generate line-level split plan.${c.reset}`);
    return false;
  }

  if (plan.splits.length < 2) {
    console.log(`${c.green}Commit is already atomic.${c.reset}`);
    return true;
  }

  return executeSplit(commit, plan, dryRun);
}
