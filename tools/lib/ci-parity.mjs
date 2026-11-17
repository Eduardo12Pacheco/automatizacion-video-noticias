/**
 * CI parity rules for `tools/run-all-tests.mjs`.
 *
 * Every local suite step declares the exact workflow command and job it
 * mirrors, and every suite-like command in the workflows must be covered.
 * Commands are compared as whole strings per job so a shorter command cannot
 * be satisfied by a substring of a different workflow line.
 */

export const SUITE_COMMAND =
  /(node --test|pytest|unittest discover|playwright test|run-panel-checks|run-visual-qa|infra\/install\/tests\/run\.sh|install\.sh --check|install\.sh --yes .*--dry-run)/;

export const WINDOWS_ONLY = /^python -m unittest discover -s infra\/install\/tests/;

const RUN_KEY = /^(\s*)(?:-\s*)?run:\s*(.*)$/;

/**
 * Extract every `run:` command from a GitHub Actions workflow, grouped by job.
 * Block scalars (`run: |`) yield one entry per non-empty command line.
 *
 * @param {string} text
 * @returns {{ job: string, command: string }[]}
 */
export function extractRunCommands(text) {
  const lines = text.split(/\r?\n/);
  const commands = [];
  let inJobs = false;
  let job = '';

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (/^jobs:\s*$/.test(line)) {
      inJobs = true;
      continue;
    }
    if (!inJobs) continue;
    if (/^\S/.test(line)) break;

    const jobMatch = /^ {2}([A-Za-z0-9_-]+):\s*$/.exec(line);
    if (jobMatch) {
      job = jobMatch[1];
      continue;
    }

    const runMatch = RUN_KEY.exec(line);
    if (!runMatch) continue;
    const [, indent, value] = runMatch;
    const trimmed = value.trim();
    if (trimmed && !trimmed.startsWith('|') && !trimmed.startsWith('>')) {
      if (job) commands.push({ job, command: trimmed });
      continue;
    }
    if (!trimmed.startsWith('|') && !trimmed.startsWith('>')) continue;

    const blockIndent = indent.length + 2;
    for (index += 1; index < lines.length; index += 1) {
      const blockLine = lines[index];
      if (!blockLine.trim()) continue;
      const currentIndent = blockLine.length - blockLine.trimStart().length;
      if (currentIndent < blockIndent) {
        index -= 1;
        break;
      }
      if (job) commands.push({ job, command: blockLine.trim() });
    }
  }

  return commands;
}

/**
 * @param {{
 *   steps: { name: string, ci?: string, ciJob?: string | string[] }[],
 *   workflows: { file: string, text: string }[],
 *   suiteCommand?: RegExp,
 *   windowsOnly?: RegExp,
 * }} input
 * @returns {string[]}
 */
function jobMatches(entryJob, ciJob) {
  if (!ciJob) return true;
  return Array.isArray(ciJob) ? ciJob.includes(entryJob) : entryJob === ciJob;
}

export function findParityProblems({ steps, workflows, suiteCommand = SUITE_COMMAND, windowsOnly = WINDOWS_ONLY }) {
  const commands = workflows.flatMap(({ file, text }) =>
    extractRunCommands(text).map((entry) => ({ ...entry, file })),
  );
  const problems = [];

  for (const step of steps) {
    if (!step.ci) continue;
    const matches = commands.filter((entry) => entry.command === step.ci && jobMatches(entry.job, step.ciJob));
    if (matches.length === 0) {
      const scope = step.ciJob ? ` in job ${JSON.stringify(step.ciJob)}` : '';
      problems.push(`${step.name}: CI no longer runs "${step.ci}"${scope}`);
    }
  }

  for (const entry of commands) {
    if (!suiteCommand.test(entry.command) || windowsOnly.test(entry.command)) continue;
    if (!steps.some((step) => step.ci === entry.command && jobMatches(entry.job, step.ciJob))) {
      problems.push(`${entry.file}: suite command is not in test:all -> ${entry.command}`);
    }
  }

  return problems;
}
