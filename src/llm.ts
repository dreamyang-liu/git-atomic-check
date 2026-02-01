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

export async function generateSplitPlan(commit: CommitInfo, model: string, previousErrors: string[] = []): Promise<SplitPlan | null> {
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

export interface PatchFixRequest {
  originalDiff: string;
  failedPatch: string;
  patchIndex: number;
  totalPatches: number;
  error: string;
  allPatches: Array<{ message: string; diff: string }>;
}

export async function fixPatch(request: PatchFixRequest, model: string): Promise<string | null> {
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
