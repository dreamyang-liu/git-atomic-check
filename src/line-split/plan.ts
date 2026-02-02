/**
 * Phase 1: Generate commit plan from diff
 * LLM reads the entire diff and decides how to split it into atomic commits
 */

import { callBedrock } from '../llm.js';
import type { CommitInfo } from '../types.js';

/**
 * A planned commit with metadata for subsequent classification
 */
export interface CommitPlan {
  id: string;                    // "commit_1", "commit_2", etc.
  message: string;               // Commit message
  description: string;           // Detailed description
  contentHint: string;           // Hint to help classify lines (e.g., "auth-related functions")
  dependsOn: string[];           // IDs of commits this depends on
}

/**
 * Result of the planning phase
 */
export interface SplitPlanResult {
  commits: CommitPlan[];
  reasoning: string;
}

/**
 * Generate a commit split plan from the diff
 * LLM only decides WHAT commits to create, not HOW to split the diff
 */
export async function generateCommitPlan(
  commit: CommitInfo,
  model: string,
  instruction?: string
): Promise<SplitPlanResult | null> {
  const customInstruction = instruction ? `\n**Custom Instruction:** ${instruction}\n` : '';

  const prompt = `You are a git expert. Analyze this commit and plan how to split it into atomic commits.

**Original Commit Message:** ${commit.message}
**Files Changed:** ${commit.filesChanged}
**Stats:** +${commit.insertions}/-${commit.deletions} lines

**Full Diff:**
\`\`\`diff
${commit.diff || '(diff not available)'}
\`\`\`
${customInstruction}
TASK: Plan how to split this into 2-5 atomic commits. Each commit should do ONE logical thing.

Rules:
1. Order commits by dependency - if commit B uses code from commit A, A must come first
2. Each commit must be independently buildable (no dangling references)
3. Group related changes together (a function and its callers, a type and its usage)
4. Import statements should go with the code that uses them

Output a JSON plan (DO NOT output any diff content, only the plan):

{
  "reasoning": "Brief explanation of how you're splitting",
  "commits": [
    {
      "id": "commit_1",
      "message": "feat(auth): Add login function",
      "description": "Adds the core login functionality",
      "contentHint": "login function, auth imports, login-related helpers",
      "dependsOn": []
    },
    {
      "id": "commit_2",
      "message": "feat(api): Add login endpoint",
      "description": "Adds API endpoint that uses the login function",
      "contentHint": "API route handler, endpoint registration",
      "dependsOn": ["commit_1"]
    }
  ]
}

If the commit is already atomic, return a single commit with all changes.
Only output the JSON, nothing else.`;

  const response = await callBedrock(prompt, model, 32768);
  if (!response) {
    return null;
  }

  try {
    const match = response.match(/\{[\s\S]*\}/);
    if (!match) {
      console.error('  No JSON found in plan response');
      return null;
    }

    const parsed = JSON.parse(match[0]);

    // Validate the structure
    if (!parsed.commits || !Array.isArray(parsed.commits)) {
      console.error('  Invalid plan structure: missing commits array');
      return null;
    }

    // Ensure all commits have required fields
    for (let i = 0; i < parsed.commits.length; i++) {
      const c = parsed.commits[i];
      if (!c.id) c.id = `commit_${i + 1}`;
      if (!c.message) c.message = `Commit ${i + 1}`;
      if (!c.description) c.description = '';
      if (!c.contentHint) c.contentHint = '';
      if (!c.dependsOn) c.dependsOn = [];
    }

    return {
      reasoning: parsed.reasoning || '',
      commits: parsed.commits,
    };
  } catch (e) {
    console.error('  Failed to parse plan JSON:', e);
    return null;
  }
}
