/**
 * Configuration constants for git-fission
 */

// Colors for terminal output
export const c = {
  green: '\x1b[92m',
  yellow: '\x1b[93m',
  red: '\x1b[91m',
  blue: '\x1b[94m',
  cyan: '\x1b[96m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  reset: '\x1b[0m',
};

export const LOGO = `
${c.dim}                                                             ${c.cyan}·${c.reset}
${c.dim}                                                        ${c.cyan}◦${c.reset}
${c.dim}                                                   ${c.cyan}·  ◦${c.reset}
${c.dim}                                              ${c.cyan}◦${c.reset}              ${c.green}⬤━━━━▶${c.reset}
${c.dim}                       ${c.yellow}╭─────────╮${c.reset}      ${c.cyan}·${c.reset}
${c.dim}                       ${c.yellow}│${c.reset}${c.bold} ◉  ◉  ◉ ${c.reset}${c.yellow}│${c.reset}   ${c.cyan}◦${c.reset}          ${c.green}⬤━━━━━━━▶${c.reset}
${c.bold}       ●${c.reset}${c.dim}━━━━━━━━━▶${c.reset}    ${c.yellow} │${c.reset}${c.bold} ◉  ◉  ◉ ${c.reset}${c.yellow}│${c.reset}
${c.dim}                       ${c.yellow}│${c.reset}${c.bold} ◉  ◉  ◉ ${c.reset}${c.yellow}│${c.reset}   ${c.cyan}◦${c.reset}          ${c.green}⬤━━━━━━━▶${c.reset}
${c.dim}                       ${c.yellow}╰─────────╯${c.reset}      ${c.cyan}·${c.reset}
${c.dim}                                              ${c.cyan}◦${c.reset}              ${c.green}⬤━━━━▶${c.reset}
${c.dim}                                                   ${c.cyan}◦  ·${c.reset}
${c.dim}                                                        ${c.cyan}◦${c.reset}
${c.dim}                                                             ${c.cyan}·${c.reset}

${c.bold}${c.green}                        ⚛  git-fission${c.reset}
${c.dim}                  Split commits into atomic pieces${c.reset}
`;

// Model configuration
export const DEFAULT_MODEL = 'us.anthropic.claude-3-5-haiku-20241022-v1:0';
