/**
 * Phase 4: Assemble patches from extracted changes
 *
 * New strategy: Instead of rebuilding file content and diffing, directly modify
 * the hunk to only include selected changes. This is more reliable.
 */

import { getFileAtRef, generateUnifiedDiff, type ParsedFileDiff, type ParsedHunk } from '../git.js';
import type { CommitChanges, LineRange } from './extract.js';

export interface AssembledPatch {
  commitId: string;
  message: string;
  description: string;
  patch: string;
}

/**
 * Modify a hunk to only include selected line changes
 *
 * For selected lines: keep as-is
 * For unselected + lines: remove entirely
 * For unselected - lines: convert to context (they stay in the file)
 */
function filterHunk(
  hunk: ParsedHunk,
  selectedIndices: Set<number>
): { header: string; content: string; hasChanges: boolean } {
  const hunkLines = hunk.content.split('\n');
  const filteredLines: string[] = [];

  // Parse original header to get line numbers
  const headerMatch = hunk.header.match(/@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/);
  if (!headerMatch) {
    return { header: hunk.header, content: hunk.content, hasChanges: false };
  }

  const oldStart = parseInt(headerMatch[1]);
  const oldCountOriginal = headerMatch[2] ? parseInt(headerMatch[2]) : 1;
  const newStart = parseInt(headerMatch[3]);
  const suffix = headerMatch[5] || '';

  let oldCount = 0;  // Lines in old file (context + deletions)
  let newCount = 0;  // Lines in new file (context + additions)
  let hasChanges = false;

  for (let lineIdx = 0; lineIdx < hunkLines.length; lineIdx++) {
    const line = hunkLines[lineIdx];
    if (line === '' && lineIdx === hunkLines.length - 1) continue;

    if (line.startsWith('+')) {
      if (selectedIndices.has(lineIdx)) {
        // Keep the addition
        filteredLines.push(line);
        newCount++;
        hasChanges = true;
      }
      // Unselected additions are simply omitted
    } else if (line.startsWith('-')) {
      if (selectedIndices.has(lineIdx)) {
        // Keep the deletion
        filteredLines.push(line);
        oldCount++;
        hasChanges = true;
      } else {
        // Unselected deletion becomes context (the line stays)
        filteredLines.push(' ' + line.slice(1));
        oldCount++;
        newCount++;
      }
    } else if (line.startsWith(' ')) {
      // Context line - always keep
      filteredLines.push(line);
      oldCount++;
      newCount++;
    }
  }

  // Build new header
  const newHeader = `@@ -${oldStart},${oldCount} +${newStart},${newCount} @@${suffix}`;

  return {
    header: newHeader,
    content: filteredLines.join('\n'),
    hasChanges,
  };
}

/**
 * Build a patch string from filtered hunks
 */
function buildPatchFromHunks(
  file: ParsedFileDiff,
  filteredHunks: Array<{ header: string; content: string }>
): string {
  if (filteredHunks.length === 0) return '';

  const parts: string[] = [];

  // Add file header
  parts.push(`diff --git a/${file.filePath} b/${file.filePath}`);

  // Check if new file
  const isNewFile = file.fileHeader.includes('new file mode') ||
                    file.fileHeader.includes('--- /dev/null');

  if (isNewFile) {
    parts.push('new file mode 100644');
    parts.push('index 0000000..0000000');
    parts.push('--- /dev/null');
  } else {
    parts.push('index 0000000..0000000 100644');
    parts.push(`--- a/${file.filePath}`);
  }
  parts.push(`+++ b/${file.filePath}`);

  // Add each hunk
  for (const hunk of filteredHunks) {
    parts.push(hunk.header);
    if (hunk.content) {
      parts.push(hunk.content);
    }
  }

  return parts.join('\n') + '\n';
}

/**
 * Build patches for all commits
 *
 * New approach: For each file change, filter the original hunks to only include
 * selected lines, then assemble those filtered hunks into a patch.
 */
export function buildPatches(
  files: ParsedFileDiff[],
  commitChanges: CommitChanges[],
  _commitHash: string
): AssembledPatch[] {
  const results: AssembledPatch[] = [];

  // Track which line indices have been used by previous commits (per hunk)
  // This is needed for line-level splitting where different lines from the
  // same hunk go to different commits
  const usedIndicesByHunk = new Map<number, Set<number>>();

  for (const commit of commitChanges) {
    const patchParts: string[] = [];

    for (const fileChange of commit.fileChanges) {
      const filePath = fileChange.filePath;
      const file = files.find(f => f.filePath === filePath);
      if (!file) continue;

      const originalContent = ctx.fileStates.get(filePath) || '';
      const isNewFile = ctx.newFiles.has(filePath) && !ctx.createdInPatch.has(filePath);
      }

      // Get previous cumulative ranges for this file
      const prevRanges = cumulativeRangesByFile.get(filePath) || [];

      // Current state = original + all previous commits' changes
      const currentContent = prevRanges.length > 0
        ? buildFileContent(originalContent, file.hunks, prevRanges)
        : originalContent;

      // Add this commit's ranges to cumulative
      const newCumulativeRanges = [...prevRanges, ...fileChange.ranges];
      cumulativeRangesByFile.set(filePath, newCumulativeRanges);



      // Target state = original + all changes up to and including this commit
      const targetContent = buildFileContent(originalContent, file.hunks, newCumulativeRanges);

      // Generate diff between current and target
      const diff = generateUnifiedDiff(filePath, currentContent, targetContent, isNewFile);

      if (diff) {
        patchParts.push(diff);

        if (isNewFile) {
          ctx.createdInPatch.add(filePath);
        }
      }
    }

    results.push({
      commitId: commit.commitId,
      message: commit.message,
      description: commit.description,
      patch: patchParts.join(''),
    });
  }

  return results;
}

export function validatePatch(patch: string): { valid: boolean; error?: string } {
  if (!patch || patch.trim() === '') {
    return { valid: false, error: 'Empty patch' };
  }

  if (!patch.includes('diff --git')) {
    return { valid: false, error: 'Missing diff header' };
  }

  if (!patch.includes('@@')) {
    return { valid: false, error: 'Missing hunk header' };
  }

  return { valid: true };
}
