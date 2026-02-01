/**
 * Atomicity checking functions (LLM-only)
 */

import { c } from './config.js';
import { analyzeWithLLM } from './llm.js';
import type { CommitInfo, AtomicityReport } from './types.js';

export async function checkCommitAtomicity(
  commit: CommitInfo,
  model: string
): Promise<AtomicityReport> {
  const issues: string[] = [];
  const warnings: string[] = [];
  const suggestions: string[] = [];

  // LLM analysis
  process.stdout.write(`  ${c.dim}Analyzing with LLM...${c.reset}`);
  const llmAnalysis = await analyzeWithLLM(commit, model) || undefined;
  process.stdout.write('\r' + ' '.repeat(40) + '\r');

  let score = 50; // Default score
  let isAtomic = false;

  if (llmAnalysis) {
    score = llmAnalysis.isAtomic ? (llmAnalysis.confidence * 100) : (30 + llmAnalysis.confidence * 20);
    isAtomic = llmAnalysis.isAtomic && llmAnalysis.confidence > 0.6;

    if (!llmAnalysis.isAtomic) {
      issues.push(...llmAnalysis.concerns);
      if (llmAnalysis.splitSuggestion) {
        suggestions.push(`LLM: ${llmAnalysis.splitSuggestion}`);
      }
    }
  } else {
    warnings.push('LLM analysis failed');
  }

  return { commit, isAtomic, score, issues, warnings, suggestions, llmAnalysis };
}

export function printReport(report: AtomicityReport, verbose: boolean): void {
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
