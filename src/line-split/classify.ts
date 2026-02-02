/**
 * Phase 2: Classify lines within each hunk
 * For each hunk, LLM decides which lines belong to which commit
 */

import { callBedrock } from '../llm.js';
import type { ParsedFileDiff, ParsedHunk } from '../git.js';
import type { CommitPlan } from './plan.js';

/**
 * Classification result for a single line
 */
export interface LineClassification {
  lineIndex: number;             // Index within hunk content
  commitId: string;              // Which commit this line belongs to
}

/**
 * Classification result for a single hunk
 */
export interface HunkClassificationResult {
  hunkId: number;
  filePath: string;
  lines: LineClassification[];
}

/**
 * Format a hunk for LLM display with line indices
 */
function formatHunkForClassification(hunk: ParsedHunk): string {
  const lines = hunk.content.split('\n');
  return lines
    .map((line, idx) => `  ${idx}: ${line}`)
    .join('\n');
}

/**
 * Format commit options for the prompt
 */
function formatCommitOptions(commits: CommitPlan[]): string {
  return commits
    .map(c => `- ${c.id}: "${c.message}" - ${c.contentHint}`)
    .join('\n');
}

/**
 * Classify lines in a single hunk
 * Returns which lines belong to which commit
 */
export async function classifyHunkLines(
  hunk: ParsedHunk,
  commits: CommitPlan[],
  model: string
): Promise<LineClassification[]> {
  // Find changed lines (+ or -)
  const hunkLines = hunk.content.split('\n');
  const changedLineIndices: number[] = [];

  for (let i = 0; i < hunkLines.length; i++) {
    const line = hunkLines[i];
    if (line.startsWith('+') || line.startsWith('-')) {
      changedLineIndices.push(i);
    }
  }

  // If no changed lines, nothing to classify
  if (changedLineIndices.length === 0) {
    return [];
  }

  // If only one commit, all lines belong to it
  if (commits.length === 1) {
    return changedLineIndices.map(idx => ({
      lineIndex: idx,
      commitId: commits[0].id,
    }));
  }

  const prompt = `You are classifying lines in a git diff hunk into commits.

**File:** ${hunk.filePath}
**Hunk starting at line ${hunk.startLine}:**
\`\`\`
${formatHunkForClassification(hunk)}
\`\`\`

**Available commits (in dependency order):**
${formatCommitOptions(commits)}

TASK: For each changed line (starting with + or -), decide which commit it belongs to.
Rules:
1. Related code should go together (e.g., a function definition and its usage)
2. Imports should go with the code that uses them
3. If unsure, prefer putting dependent code in later commits

Only classify lines that start with + or - (not context lines starting with space).

Output JSON array only:
[{"line": 0, "commit": "commit_1"}, {"line": 3, "commit": "commit_2"}, ...]

Only output the JSON array, nothing else.`;

  const response = await callBedrock(prompt, model, 2048);
  if (!response) {
    // Fallback: assign all to first commit
    return changedLineIndices.map(idx => ({
      lineIndex: idx,
      commitId: commits[0].id,
    }));
  }

  try {
    const match = response.match(/\[[\s\S]*\]/);
    if (!match) {
      // Fallback
      return changedLineIndices.map(idx => ({
        lineIndex: idx,
        commitId: commits[0].id,
      }));
    }

    const parsed = JSON.parse(match[0]) as Array<{ line: number; commit: string }>;

    // Convert to our format and validate
    const validCommitIds = new Set(commits.map(c => c.id));
    const results: LineClassification[] = [];

    for (const item of parsed) {
      if (typeof item.line === 'number' && typeof item.commit === 'string') {
        // Validate commit ID
        const commitId = validCommitIds.has(item.commit) ? item.commit : commits[0].id;
        results.push({
          lineIndex: item.line,
          commitId,
        });
      }
    }

    // Ensure all changed lines are classified
    const classifiedIndices = new Set(results.map(r => r.lineIndex));
    for (const idx of changedLineIndices) {
      if (!classifiedIndices.has(idx)) {
        // Assign unclassified lines to first commit
        results.push({
          lineIndex: idx,
          commitId: commits[0].id,
        });
      }
    }

    return results;
  } catch (e) {
    // Fallback on parse error
    return changedLineIndices.map(idx => ({
      lineIndex: idx,
      commitId: commits[0].id,
    }));
  }
}

/**
 * Classify all hunks in parallel
 * Returns classification results for all hunks
 */
export async function classifyAllHunks(
  files: ParsedFileDiff[],
  commits: CommitPlan[],
  model: string,
  concurrency: number = 5
): Promise<HunkClassificationResult[]> {
  const allHunks: Array<{ hunk: ParsedHunk; filePath: string }> = [];

  for (const file of files) {
    for (const hunk of file.hunks) {
      allHunks.push({ hunk, filePath: file.filePath });
    }
  }

  const results: HunkClassificationResult[] = [];

  // Process in batches for controlled concurrency
  for (let i = 0; i < allHunks.length; i += concurrency) {
    const batch = allHunks.slice(i, i + concurrency);
    const batchResults = await Promise.all(
      batch.map(async ({ hunk, filePath }) => {
        const lines = await classifyHunkLines(hunk, commits, model);
        return {
          hunkId: hunk.id,
          filePath,
          lines,
        };
      })
    );
    results.push(...batchResults);
  }

  return results;
}
