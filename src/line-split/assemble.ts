/**
 * Phase 4: Assemble patches from extracted changes
 *
 * Strategy: Instead of using absolute line numbers (which break when file state changes),
 * we track changes by hunk position and rebuild content progressively.
 */

import { getFileAtRef, generateUnifiedDiff, type ParsedFileDiff, type ParsedHunk } from '../git.js';
import type { CommitChanges, LineRange } from './extract.js';

export interface AssembledPatch {
  commitId: string;
  message: string;
  description: string;
  patch: string;
}

interface PatchBuildContext {
  fileStates: Map<string, string>;
  newFiles: Set<string>;
  createdInPatch: Set<string>;
}

/**
 * Get the final state of a file after applying selected changes from hunks
 *
 * This works by:
 * 1. Starting from the original file content
 * 2. Processing each hunk in order
 * 3. For each hunk, applying only the selected +/- lines
 */
function buildFileContent(
  originalContent: string,
  hunks: ParsedHunk[],
  selectedRanges: LineRange[]
): string {
  if (hunks.length === 0) return originalContent;

  // Build a map of which line indices are selected for each hunk
  const selectedByHunk = new Map<number, Set<number>>();
  for (const range of selectedRanges) {
    if (!selectedByHunk.has(range.hunkId)) {
      selectedByHunk.set(range.hunkId, new Set());
    }
    for (let i = range.startLineIdx; i <= range.endLineIdx; i++) {
      selectedByHunk.get(range.hunkId)!.add(i);
    }
  }

  const originalLines = originalContent === '' ? [] : originalContent.split('\n');
  const result: string[] = [];
  let originalIdx = 0;  // Current position in original file

  for (const hunk of hunks) {
    // Get hunk's starting position in original file
    const headerMatch = hunk.header.match(/@@ -(\d+)/);
    const hunkStartLine = headerMatch ? parseInt(headerMatch[1]) - 1 : 0;  // 0-indexed

    // Copy lines before this hunk
    while (originalIdx < hunkStartLine && originalIdx < originalLines.length) {
      result.push(originalLines[originalIdx]);
      originalIdx++;
    }

    // Process hunk lines
    const hunkLines = hunk.content.split('\n');
    const selected = selectedByHunk.get(hunk.id) || new Set();

    for (let lineIdx = 0; lineIdx < hunkLines.length; lineIdx++) {
      const line = hunkLines[lineIdx];
      if (line === '' && lineIdx === hunkLines.length - 1) continue;

      if (line.startsWith('+')) {
        // Addition - only include if selected
        if (selected.has(lineIdx)) {
          result.push(line.slice(1));
        }
      } else if (line.startsWith('-')) {
        // Removal - skip original line if selected, keep if not selected
        if (selected.has(lineIdx)) {
          // Skip this line (it's being removed)
          originalIdx++;
        } else {
          // Not selected - keep the original line
          if (originalIdx < originalLines.length) {
            result.push(originalLines[originalIdx]);
          }
          originalIdx++;
        }
      } else if (line.startsWith(' ')) {
        // Context line - copy from original
        if (originalIdx < originalLines.length) {
          result.push(originalLines[originalIdx]);
        }
        originalIdx++;
      }
    }
  }

  // Copy remaining lines after all hunks
  while (originalIdx < originalLines.length) {
    result.push(originalLines[originalIdx]);
    originalIdx++;
  }

  return result.join('\n');
}

/**
 * Initialize context with original file states
 */
function initializeContext(
  files: ParsedFileDiff[],
  commitHash: string
): PatchBuildContext {
  const fileStates = new Map<string, string>();
  const newFiles = new Set<string>();
  const createdInPatch = new Set<string>();

  for (const file of files) {
    const isNewFile = file.fileHeader.includes('new file mode') ||
                      file.fileHeader.includes('--- /dev/null');

    if (isNewFile) {
      newFiles.add(file.filePath);
      fileStates.set(file.filePath, '');
    } else {
      const content = getFileAtRef(`${commitHash}~1`, file.filePath);
      fileStates.set(file.filePath, content || '');
    }
  }

  return { fileStates, newFiles, createdInPatch };
}

/**
 * Build patches for all commits
 *
 * Key insight: For each commit, we calculate what the file should look like
 * by starting from original and applying only the changes up to and including
 * this commit.
 */
export function buildPatches(
  files: ParsedFileDiff[],
  commitChanges: CommitChanges[],
  commitHash: string
): AssembledPatch[] {
  const ctx = initializeContext(files, commitHash);
  const results: AssembledPatch[] = [];

  // Track cumulative ranges per file (all ranges from commit 1 to N)
  const cumulativeRangesByFile = new Map<string, LineRange[]>();

  for (const commit of commitChanges) {
    const patchParts: string[] = [];

    for (const fileChange of commit.fileChanges) {
      const filePath = fileChange.filePath;
      const file = files.find(f => f.filePath === filePath);
      if (!file) continue;

      const originalContent = ctx.fileStates.get(filePath) || '';
      const isNewFile = ctx.newFiles.has(filePath) && !ctx.createdInPatch.has(filePath);

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
