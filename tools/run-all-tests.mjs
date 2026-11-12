#!/usr/bin/env node
/**
 * One local command for the full CI test matrix.
 *
 * `pnpm test:all` runs the same node/python/panel/installer suites as the
 * GitHub workflows and prints a summary table. The Playwright demo E2E needs
 * the Docker stack, so it is opt-in with NEWSROOM_E2E=1 (CI runs it in its own
 * job after starting the stack).
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';

const isWindows = process.platform === 'win32';
const python = isWindows ? 'python' : 'python3';
const wantE2E = process.env.NEWSROOM_E2E === '1' || process.argv.includes('--e2e');
const wantLocalE2E = process.env.NEWSROOM_E2E_LOCAL === '1' || process.argv.includes('--e2e-local');
const playwrightBin = join('node_modules', '.bin', isWindows ? 'playwright.cmd' : 'playwright');

// A skip is only acceptable when the missing runtime is optional on this host.
// `node tools/run-all-tests.mjs` reports every skip in its own column and exits
// non-zero when a CI suite is skipped for a reason that is not on this list.
const SKIP_ALLOWLIST = new Set([
  'missing-bash',
  'missing-docker',
  'missing-playwright',
  'needs-stack',
]);
const skip = (code, reason) => ({ code, reason });
const hasCommand = (name) => {
  const path = process.env.PATH || '';
  const extensions = isWindows ? ['', '.exe', '.cmd', '.bat'] : [''];
  return path.split(delimiter).some((dir) => extensions.some((ext) => existsSync(`${dir}/${name}${ext}`)));
};

const steps = [
  // Lint/parity steps mirror the `lint` job in .github/workflows/ci.yml.
  {
    name: 'lint-node',
    command: 'bash',
    args: ['-c', "git ls-files '*.js' '*.mjs' '*.cjs' | while IFS= read -r file; do node --check \"$file\"; done"],
    ci: "git ls-files '*.js' '*.mjs' '*.cjs'",
    skip: !hasCommand('bash') ? skip('missing-bash', 'bash is not available on this host') : null,
  },
  {
    name: 'lint-shell',
    command: 'bash',
    args: ['-c', "git ls-files '*.sh' | while IFS= read -r file; do bash -n \"$file\"; done"],
    ci: "git ls-files '*.sh'",
    skip: !hasCommand('bash') ? skip('missing-bash', 'bash is not available on this host') : null,
  },
  { name: 'lint-python', command: python, args: ['-m', 'compileall', '-q', 'apps', 'packages', 'services', 'tools', 'infra/install'], ci: 'python3 -m compileall -q apps packages services tools infra/install' },
  { name: 'core', command: 'node', args: ['--test', 'packages/core/test/*.test.js'], ci: 'node --test packages/core/test/*.test.js' },
  { name: 'data', command: 'node', args: ['--test', 'packages/data/test/*.test.js'], ci: 'node --test packages/data/test/*.test.js' },
  { name: 'contracts', command: 'node', args: ['--test', 'packages/contracts/test/*.test.js'], ci: 'node --test packages/contracts/test/*.test.js' },
  { name: 'adapters', command: 'node', args: ['--test', 'packages/adapters/test/*.test.js'], ci: 'node --test packages/adapters/test/*.test.js' },
  { name: 'api', command: 'node', args: ['--test', 'apps/api/test/*.test.js'], ci: 'node --test apps/api/test/*.test.js' },
  { name: 'renderer', command: 'node', args: ['--test', 'services/renderer/tests/*.test.js'], ci: 'node --test services/renderer/tests/*.test.js' },
  { name: 'approval-editor', command: 'node', args: ['--test', 'services/approval-editor/test/*.test.js', 'services/approval-editor/__checks__/*.mjs'], ci: 'node --test services/approval-editor/test/*.test.js services/approval-editor/__checks__/*.mjs' },
  { name: 'demo-worker', command: 'node', args: ['--test', 'services/demo-worker/test/*.test.js'], ci: 'node --test services/demo-worker/test/*.test.js' },
  { name: 'tools', command: python, args: ['-m', 'unittest', 'discover', '-s', 'tools/tests', '-v'], ci: 'python3 -m unittest discover -s tools/tests -v' },
  { name: 'panel', command: 'uv', args: ['run', '--with', 'pytest', 'pytest', 'apps/panel/tests', '-q'], ci: 'pytest apps/panel/tests -q' },
  { name: 'panel-checks', command: 'node', args: ['tools/run-panel-checks.mjs'], ci: 'node tools/run-panel-checks.mjs' },
  {
    name: 'asr-worker',
    command: 'uv',
    args: ['run', '--project', 'services/asr-worker', '--with', 'pytest', '--with', 'httpx', 'pytest', 'services/asr-worker/tests', '-q'],
    ci: 'pytest services/asr-worker/tests -q',
  },
  {
    name: 'tts-worker',
    command: 'uv',
    args: ['run', '--project', 'services/tts-worker', '--with', 'pytest', 'pytest', 'services/tts-worker/tests', '-q'],
    ci: 'pytest services/tts-worker/tests -q',
  },
  {
    name: 'worker-common',
    command: 'uv',
    args: ['run', '--project', 'packages/python/newsroom_worker_common', '--with', 'pytest', 'pytest', 'packages/python/newsroom_worker_common/tests', '-q'],
    ci: 'pytest packages/python/newsroom_worker_common/tests -q',
  },
  {
    name: 'local-adapters',
    command: 'uv',
    args: ['run', '--project', 'packages/python/newsroom_local_adapters', '--with', 'pytest', '--with', 'python-docx', 'pytest', 'packages/python/newsroom_local_adapters/tests', '-q'],
    ci: 'pytest packages/python/newsroom_local_adapters/tests -q',
  },
  {
    name: 'channel-monitor',
    command: 'uv',
    args: ['run', '--project', 'services/channel-monitor', '--with', 'pytest', '--with', 'httpx', '--with', 'pyyaml', '--with', 'uvicorn', 'pytest', 'services/channel-monitor/tests', '-q'],
    ci: 'pytest services/channel-monitor/tests -q',
  },
  {
    name: 'subtitles',
    command: 'uv',
    args: ['run', '--project', 'services/subtitles', '--extra', 'translation', '--with', 'pytest', '--with', 'httpx', '--with', 'pyyaml', 'pytest', 'services/subtitles/tests', '-q'],
    ci: 'pytest services/subtitles/tests -q',
  },
  {
    name: 'installers',
    command: 'bash',
    args: ['infra/install/tests/run.sh'],
    ci: 'bash infra/install/tests/run.sh',
    skip: !hasCommand('bash') ? skip('missing-bash', 'bash is not available on this host') : null,
  },
  {
    name: 'installers-check',
    command: 'bash',
    args: ['install.sh', '--check'],
    ci: './install.sh --check',
    skip: !hasCommand('bash') ? skip('missing-bash', 'bash is not available on this host')
      : !hasCommand('docker') ? skip('missing-docker', './install.sh --check needs Docker on this host') : null,
  },
  {
    name: 'installers-dry-run',
    command: 'bash',
    args: ['install.sh', '--yes', '--profile', 'cpu', '--dry-run', '--no-open'],
    ci: './install.sh --yes --profile cpu --dry-run --no-open',
    skip: !hasCommand('bash') ? skip('missing-bash', 'bash is not available on this host') : null,
  },
  {
    name: 'compose-config',
    command: 'docker',
    args: ['compose', '--env-file', 'e2e/.env.example', '-f', 'compose.yaml', 'config', '-q'],
    ci: 'docker compose --env-file e2e/.env.example -f compose.yaml config -q',
    skip: !hasCommand('docker') ? skip('missing-docker', 'docker is not available on this host') : null,
  },
  {
    name: 'compose-config-gpu-n8n',
    command: 'docker',
    args: ['compose', '--env-file', 'e2e/.env.example', '--profile', 'gpu', '--profile', 'n8n', '-f', 'compose.yaml', 'config', '-q'],
    ci: 'docker compose --env-file e2e/.env.example --profile gpu --profile n8n -f compose.yaml config -q',
    skip: !hasCommand('docker') ? skip('missing-docker', 'docker is not available on this host') : null,
  },
  {
    name: 'compose-alias',
    command: 'node',
    args: ['-e', "process.exit(require('node:fs').existsSync('docker-compose.yml') ? 1 : 0)"],
    ci: 'test ! -e docker-compose.yml',
  },
  {
    name: 'visual-qa',
    command: 'node',
    args: ['tools/run-visual-qa.mjs'],
    ci: 'node tools/run-visual-qa.mjs',
    skip: !existsSync('node_modules/.bin/playwright') ? skip('missing-playwright', 'Playwright is not installed (run pnpm install + playwright install chromium)') : null,
  },
  {
    name: 'e2e-demo',
    command: playwrightBin,
    args: ['test', 'e2e/happy-path.spec.js', 'e2e/panel-flows.spec.js'],
    ci: 'pnpm exec playwright test',
    skip: !wantE2E ? skip('needs-stack', 'set NEWSROOM_E2E=1 after starting the demo stack to run the Playwright E2E')
      : !existsSync(playwrightBin) ? skip('missing-playwright', 'Playwright is not installed (run pnpm install + playwright install chromium)') : null,
  },
  {
    name: 'e2e-local',
    command: playwrightBin,
    args: ['test', 'e2e/local-mode.spec.js'],
    ci: 'pnpm exec playwright test e2e/local-mode.spec.js',
    skip: !wantLocalE2E ? skip('needs-stack', 'set NEWSROOM_E2E_LOCAL=1 after preparing the local stack to run this E2E')
      : !existsSync(playwrightBin) ? skip('missing-playwright', 'Playwright is not installed (run pnpm install + playwright install chromium)') : null,
  },
];

// The matrix is checked against the CI workflows in both directions: every
// step declares the command it mirrors, and every suite-like `run:` line in
// ci.yml/installers.yml must be represented here. The nightly local-mode job is
// included too; it is the e2e-local step.
const workflowFiles = ['.github/workflows/ci.yml', '.github/workflows/installers.yml', '.github/workflows/local-mode.yml'];
const workflowText = workflowFiles.map((file) => readFileSync(file, 'utf8')).join('\n');
const parityProblems = [];
for (const step of steps) {
  if (step.ci && !workflowText.includes(step.ci)) {
    parityProblems.push(`${step.name}: CI no longer runs "${step.ci}"`);
  }
}
const CI_SUITE = /(node --test|pytest|unittest discover|playwright test|run-panel-checks|run-visual-qa|infra\/install\/tests\/run\.sh|install\.sh --check|install\.sh --yes .*--dry-run)/;
const WINDOWS_ONLY = /^python -m unittest discover -s infra\/install\/tests/;
for (const file of workflowFiles) {
  for (const rawLine of readFileSync(file, 'utf8').split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    if (!CI_SUITE.test(line) || WINDOWS_ONLY.test(line)) continue;
    if (!steps.some((step) => step.ci && line.includes(step.ci))) {
      parityProblems.push(`${file}: suite command is not in test:all -> ${line}`);
    }
  }
}
if (parityProblems.length) {
  process.stderr.write('CI parity check failed:\n');
  for (const problem of parityProblems) process.stderr.write(`  - ${problem}\n`);
  process.exit(1);
}

function formatDuration(ms) {
  return `${(ms / 1000).toFixed(1)}s`;
}

const results = [];
for (const step of steps) {
  if (step.skip) {
    const allowed = SKIP_ALLOWLIST.has(step.skip.code);
    results.push({ name: step.name, status: 'SKIP', duration: 0, reason: step.skip.reason, allowed });
    process.stdout.write(`SKIP  ${step.name} — ${step.skip.reason} (${allowed ? 'allow-listed' : 'NOT allow-listed'})\n`);
    continue;
  }
  const started = Date.now();
  process.stdout.write(`\n▶ ${step.name}: ${step.command} ${step.args.join(' ')}\n`);
  const result = spawnSync(step.command, step.args, { stdio: 'inherit', shell: false });
  const duration = Date.now() - started;
  if (result.error) {
    results.push({ name: step.name, status: 'FAIL', duration, reason: result.error.message });
    process.stdout.write(`FAIL  ${step.name} — ${result.error.message}\n`);
    continue;
  }
  const status = result.status === 0 ? 'PASS' : 'FAIL';
  results.push({ name: step.name, status, duration, reason: '' });
  process.stdout.write(`${status}  ${step.name} (${formatDuration(duration)})\n`);
}

const failed = results.filter((result) => result.status === 'FAIL');
const skipped = results.filter((result) => result.status === 'SKIP');
const unexpectedSkips = skipped.filter((result) => !result.allowed);
const width = Math.max(...results.map((result) => result.name.length), 'suite'.length);
process.stdout.write(`\n${'suite'.padEnd(width)}  result  duration  details\n`);
process.stdout.write(`${'-'.repeat(width)}  ------  --------  -------\n`);
for (const result of results) {
  process.stdout.write(
    `${result.name.padEnd(width)}  ${result.status.padEnd(6)}  ${formatDuration(result.duration).padEnd(8)}  ${result.reason || ''}\n`,
  );
}
const passed = results.filter((result) => result.status === 'PASS').length;
process.stdout.write(`\n${passed}/${results.length} suites passed, ${failed.length} failed, ${skipped.length} skipped (${unexpectedSkips.length} unexpected)\n`);
if (unexpectedSkips.length) {
  process.stderr.write('Unallow-listed skips: ' + unexpectedSkips.map((result) => result.name).join(', ') + '\n');
}
process.exit(failed.length === 0 && unexpectedSkips.length === 0 ? 0 : 1);
