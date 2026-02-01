/**
 * LLM-related functions for git-fission
 */

import { BedrockRuntimeClient, ConverseCommand } from '@aws-sdk/client-bedrock-runtime';
import type { CommitInfo, LLMAnalysis, SplitPlan } from './types.js';

export async function callBedrock(prompt: string, model: string, maxTokens = 1024): Promise<string | null> {
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

export async function analyzeWithLLM(commit: CommitInfo, model: string): Promise<LLMAnalysis | null> {
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

import { parseDiffWithLines, rebuildPatchFromLineIds, type ParsedDiffWithLines, type ChangedLine } from './git.js';

/**
 * Line classification result from LLM
 */
export interface LineClassification {
  commits: Array<{
    message: string;
    description: string;
    lineIds: number[];
  }>;
  reasoning: string;
}

/**
 * Ask LLM to classify changed lines into commits
 */
export async function classifyLines(
  commit: CommitInfo,
  parsed: ParsedDiffWithLines,
  model: string
): Promise<LineClassification | null> {
  // Group lines by file for display
  const linesByFile = new Map<string, ChangedLine[]>();
  for (const line of parsed.lines) {
    if (!linesByFile.has(line.filePath)) {
      linesByFile.set(line.filePath, []);
    }
    linesByFile.get(line.filePath)!.push(line);
  }

  // Build display for LLM
  let linesDisplay = '';
  for (const [filePath, lines] of linesByFile) {
    linesDisplay += `\n**${filePath}:**\n`;
    for (const line of lines) {
      const prefix = line.type;
      const content = line.content.length > 60 ? line.content.slice(0, 60) + '...' : line.content;
      linesDisplay += `  [${line.id}] ${prefix}${content}\n`;
    }
  }

  const prompt = `You are a git expert. Analyze this commit and decide how to split it into atomic commits.

**Original Commit Message:** ${commit.message}
**Files Changed:** ${commit.filesChanged}
**Stats:** +${commit.insertions}/-${commit.deletions} lines

**Changed lines to classify:**
${linesDisplay}

TASK: Classify each line into one of 2-5 atomic commits. Each commit should do ONE logical thing.

Rules:
1. Every line ID must appear in exactly ONE commit
2. Related changes should stay together (e.g., a function and its callers)
3. If a - line and + line are a replacement pair (same logical change), keep them together
4. Import statements should go with the code that uses them

Respond in JSON:
{
  "reasoning": "Brief explanation of how you're splitting this",
  "commits": [
    {
      "message": "feat(auth): Add login function",
      "description": "What this commit does",
      "lineIds": [0, 2, 5]
    }
  ]
}

If the commit is already atomic, return a single commit with all line IDs.
Only output the JSON.`;

  const response = await callBedrock(prompt, model, 8192);
  if (!response) {
    console.error('  LLM returned no response');
    return null;
  }

  try {
    const match = response.match(/\{[\s\S]*\}/);
    if (!match) {
      console.error('  No JSON found in response:', response.slice(0, 200));
      return null;
    }
    return JSON.parse(match[0]);
  } catch (e) {
    console.error('  Failed to parse JSON:', e);
    return null;
  }
}

/**
 * Generate split plan using line-level classification
 */
export async function generateSplitPlan(commit: CommitInfo, model: string): Promise<SplitPlan | null> {
  if (!commit.diff) return null;

  // Parse diff with line-level granularity
  const parsed = parseDiffWithLines(commit.diff);

  if (parsed.lines.length === 0) {
    return null;
  }

  console.log(`  ${parsed.lines.length} changed lines across ${parsed.files.length} files`);

  // Ask LLM to classify lines
  const classification = await classifyLines(commit, parsed, model);
  if (!classification) return null;

  // Rebuild patches from classification
  const splits = classification.commits.map(c => ({
    message: c.message,
    description: c.description,
    diff: rebuildPatchFromLineIds(parsed, c.lineIds),
  }));

  return {
    reasoning: classification.reasoning,
    splits,
  };
}

export interface PatchFixRequest {
  originalDiff: string;
  failedPatch: string;
  patchIndex: number;
  totalPatches: number;
  error: string;
  allPatches: Array<{ message: string; diff: string }>;
  targetFileContent?: string;  // The actual file content at HEAD~1
  targetFilePath?: string;     // The file path being patched
}

export async function fixPatch(request: PatchFixRequest, model: string): Promise<string | null> {
  const fileContentSection = request.targetFileContent && request.targetFilePath
    ? `\n**Full file content at HEAD~1 (${request.targetFilePath}):**
\`\`\`
${request.targetFileContent.slice(0, 15000)}${request.targetFileContent.length > 15000 ? '\n...(truncated)' : ''}
\`\`\`

IMPORTANT: The context lines (lines starting with space) in your patch MUST exactly match the lines in this file.
`
    : '';

  const prompt = `You are a git expert. A patch failed to apply with \`git apply\`. Fix the patch.

**Original Commit Diff:**
\`\`\`diff
${request.originalDiff}
\`\`\`

**Failed Patch (${request.patchIndex + 1}/${request.totalPatches}):**
\`\`\`diff
${request.failedPatch}
\`\`\`

**Error from git apply:**
\`\`\`
${request.error}
\`\`\`
${fileContentSection}
**All Patches in the Split Plan:**
${request.allPatches.map((p, i) => `Patch ${i + 1}: ${p.message}\n\`\`\`diff\n${p.diff.slice(0, 500)}${p.diff.length > 500 ? '\n...(truncated)' : ''}\n\`\`\``).join('\n\n')}

TASK: Fix patch ${request.patchIndex + 1} so it can be applied successfully.

Common issues to check:
1. Line numbers in @@ headers must be accurate
2. Context lines (lines starting with space) must match the original file exactly
3. The patch must not overlap with other patches
4. Ensure proper newlines and no trailing whitespace issues

Respond with ONLY the fixed diff, starting with "diff --git". No explanation, no JSON, just the raw diff.`;

  const response = await callBedrock(prompt, model, 16384);
  if (!response) return null;

  // Extract the diff from the response
  const diffMatch = response.match(/diff --git[\s\S]*/);
  return diffMatch ? diffMatch[0].trim() + '\n' : null;
}
