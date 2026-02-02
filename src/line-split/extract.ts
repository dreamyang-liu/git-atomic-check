/**
 * Phase 3: Extract line content from original diff
 * Pure script processing - no LLM involved
 * Uses line ranges instead of individual lines for efficiency
 */

import type { ParsedFileDiff } from '../git.js';
import type { CommitPlan } from './plan.js';
import type { HunkClassificationResult } from './classify.js';

/**
 * A range of consecutive lines of the same type
 */
export interface LineRange {
  hunkId: number;
  startLineIdx: number;          // Start index within hunk content
  endLineIdx: number;            // End index (inclusive)
  type: '+' | '-';
  lines: string[];               // Content without +/- prefix
  // Line numbers for patch generation
  startOriginalLineNum: number;  // For - ranges (1-indexed)
  startNewLineNum: number;       // For + ranges (1-indexed)
}

/**
 * Changes for a single file
 */
export interface FileChanges {
  filePath: string;
  ranges: LineRange[];
}

/**
 * Changes grouped by commit
 */
export interface CommitChanges {
  commitId: string;
  message: string;
  description: string;
  fileChanges: FileChanges[];
}

/**
 * Build a map of (hunkId, lineIndex) -> commitId from classification results
 */
function buildClassificationMap(
  classifications: HunkClassificationResult[]
): Map<string, string> {
  const map = new Map<string, string>();

  for (const hunkResult of classifications) {
    for (const line of hunkResult.lines) {
      const key = `${hunkResult.hunkId}:${line.lineIndex}`;
      map.set(key, line.commitId);
    }
  }

  return map;
}

/**
 * Extract all changes from parsed diff and group by commit using line ranges
 */
export function extractChanges(
  files: ParsedFileDiff[],
  commits: CommitPlan[],
  classifications: HunkClassificationResult[]
): CommitChanges[] {
  const classMap = buildClassificationMap(classifications);

  // Temporary structure: commitId -> filePath -> ranges[]
  const commitFileRanges = new Map<string, Map<string, LineRange[]>>();

  for (const commit of commits) {
    commitFileRanges.set(commit.id, new Map());
  }

  // Process each file and hunk
  for (const file of files) {
    for (const hunk of file.hunks) {
      const hunkLines = hunk.content.split('\n');

      // Parse hunk header for line numbers
      let originalLineNum = hunk.startLine;
      let newLineNum = hunk.startLine;

      const headerMatch = hunk.header.match(/@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
      if (headerMatch) {
        originalLineNum = parseInt(headerMatch[1]);
        newLineNum = parseInt(headerMatch[2]);
      }

      // Track current range being built
      let currentRange: {
        commitId: string;
        type: '+' | '-';
        startIdx: number;
        lines: string[];
        startOriginalLineNum: number;
        startNewLineNum: number;
      } | null = null;

      const flushRange = () => {
        if (!currentRange) return;

        const fileRanges = commitFileRanges.get(currentRange.commitId)!;
        if (!fileRanges.has(file.filePath)) {
          fileRanges.set(file.filePath, []);
        }

        fileRanges.get(file.filePath)!.push({
          hunkId: hunk.id,
          startLineIdx: currentRange.startIdx,
          endLineIdx: currentRange.startIdx + currentRange.lines.length - 1,
          type: currentRange.type,
          lines: currentRange.lines,
          startOriginalLineNum: currentRange.startOriginalLineNum,
          startNewLineNum: currentRange.startNewLineNum,
        });

        currentRange = null;
      };

      for (let lineIdx = 0; lineIdx < hunkLines.length; lineIdx++) {
        const line = hunkLines[lineIdx];

        // Skip empty lines at end
        if (line === '' && lineIdx === hunkLines.length - 1) continue;

        if (line.startsWith('+') || line.startsWith('-')) {
          const type = line[0] as '+' | '-';
          const content = line.slice(1);
          const key = `${hunk.id}:${lineIdx}`;
          const commitId = classMap.get(key) || commits[0].id;

          // Check if we can extend the current range
          if (currentRange &&
              currentRange.commitId === commitId &&
              currentRange.type === type &&
              currentRange.startIdx + currentRange.lines.length === lineIdx) {
            // Extend current range
            currentRange.lines.push(content);
          } else {
            // Flush previous range and start new one
            flushRange();
            currentRange = {
              commitId,
              type,
              startIdx: lineIdx,
              lines: [content],
              startOriginalLineNum: type === '-' ? originalLineNum : -1,
              startNewLineNum: type === '+' ? newLineNum : -1,
            };
          }

          // Update line counters
          if (type === '+') {
            newLineNum++;
          } else {
            originalLineNum++;
          }
        } else {
          // Context line - flush any current range
          flushRange();
          originalLineNum++;
          newLineNum++;
        }
      }

      // Flush final range
      flushRange();
    }
  }

  // Convert to final structure
  return commits.map(commit => {
    const fileRangesMap = commitFileRanges.get(commit.id)!;
    const fileChanges: FileChanges[] = [];

    for (const [filePath, ranges] of fileRangesMap) {
      if (ranges.length > 0) {
        fileChanges.push({ filePath, ranges });
      }
    }

    return {
      commitId: commit.id,
      message: commit.message,
      description: commit.description,
      fileChanges,
    };
  });
}

/**
 * Validate that all changed lines are assigned to exactly one commit
 */
export function validateExtraction(
  files: ParsedFileDiff[],
  commitChanges: CommitChanges[]
): { valid: boolean; errors: string[] } {
  const errors: string[] = [];

  // Count total changed lines in original diff
  let totalChangedLines = 0;
  for (const file of files) {
    for (const hunk of file.hunks) {
      const lines = hunk.content.split('\n');
      for (const line of lines) {
        if (line.startsWith('+') || line.startsWith('-')) {
          totalChangedLines++;
        }
      }
    }
  }

  // Count extracted changes and check for duplicates
  let extractedChanges = 0;
  const seenRanges = new Set<string>();

  for (const commit of commitChanges) {
    for (const fileChange of commit.fileChanges) {
      for (const range of fileChange.ranges) {
        const key = `${range.hunkId}:${range.startLineIdx}-${range.endLineIdx}`;

        if (seenRanges.has(key)) {
          errors.push(`Duplicate range: ${key} in commit ${commit.commitId}`);
        }
        seenRanges.add(key);
        extractedChanges += range.lines.length;
      }
    }
  }

  if (extractedChanges !== totalChangedLines) {
    errors.push(`Line count mismatch: extracted ${extractedChanges}, expected ${totalChangedLines}`);
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}
