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
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { tmpdir } from 'node:os';

import { findParityProblems } from './lib/ci-parity.mjs';
import { classifyNestedSkips, parseNestedSkips } from './lib/nested-skips.mjs';

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
  'missing-python-docx',
  'needs-stack',
]);
const skip = (code, reason) => ({ code, reason });
const hasCommand = (name) => {
  const path = process.env.PATH || '';
  const extensions = isWindows ? ['', '.exe', '.cmd', '.bat'] : [''];
  return path.split(delimiter).some((dir) => extensions.some((ext) => existsSync(`${dir}/${name}${ext}`)));
};
const liveOptIn = { code: 'live-opt-in', match: /^set (NEWSROOM_LIVE_TESTS=1|S3_TEST_ENDPOINT)/ };
const missingPwsh = { code: 'missing-pwsh', match: /pwsh\/powershell is not installed|pwsh.*not available/i };

const steps = [
  // Lint/parity steps mirror the `lint` job in .github/workflows/ci.yml.
  {
    name: 'lint-node',
    command: 'bash',
    args: ['-c', "git ls-files '*.js' '*.mjs' '*.cjs' | while IFS= read -r file; do node --check \"$file\"; done"],
    ci: "git ls-files '*.js' '*.mjs' '*.cjs' | while IFS= read -r file; do node --check \"$file\"; done",
    ciJob: 'lint',
    skip: !hasCommand('bash') ? skip('missing-bash', 'bash is not available on this host') : null,
  },
  {
    name: 'lint-shell',
    command: 'bash',
    args: ['-c', "git ls-files '*.sh' | while IFS= read -r file; do bash -n \"$file\"; done"],
    ci: "git ls-files '*.sh' | while IFS= read -r file; do bash -n \"$file\"; done",
    ciJob: 'lint',
    skip: !hasCommand('bash') ? skip('missing-bash', 'bash is not available on this host') : null,
  },
  {
    name: 'lint-python',
    command: python,
    args: ['-m', 'compileall', '-q', 'apps', 'packages', 'services', 'tools', 'infra/install'],
    ci: 'python3 -m compileall -q apps packages services tools infra/install',
    ciJob: 'lint',
  },
  { name: 'core', command: 'node', args: ['--test', 'packages/core/test/*.test.js'], ci: 'node --test packages/core/test/*.test.js', ciJob: 'js-suites', skipParser: 'node' },
  {
    name: 'data',
    command: 'node',
    args: ['--test', 'packages/data/test/*.test.js'],
    ci: 'node --test packages/data/test/*.test.js',
    ciJob: 'js-suites',
    skipParser: 'node',
    nestedSkipAllowlist: [liveOptIn],
  },
  { name: 'contracts', command: 'node', args: ['--test', 'packages/contracts/test/*.test.js'], ci: 'node --test packages/contracts/test/*.test.js', ciJob: 'js-suites', skipParser: 'node' },
  {
    name: 'adapters',
    command: 'node',
    args: ['--test', 'packages/adapters/test/*.test.js'],
    ci: 'node --test packages/adapters/test/*.test.js',
    ciJob: 'js-suites',
    skipParser: 'node',
    nestedSkipAllowlist: [liveOptIn],
  },
  { name: 'api', command: 'node', args: ['--test', 'apps/api/test/*.test.js'], ci: 'node --test apps/api/test/*.test.js', ciJob: 'js-suites', skipParser: 'node' },
  { name: 'renderer', command: 'node', args: ['--test', 'services/renderer/tests/*.test.js'], ci: 'node --test services/renderer/tests/*.test.js', ciJob: 'js-suites', skipParser: 'node' },
  {
    name: 'approval-editor',
    command: 'node',
    args: ['--test', 'services/approval-editor/test/*.test.js', 'services/approval-editor/__checks__/*.mjs'],
    ci: 'node --test services/approval-editor/test/*.test.js services/approval-editor/__checks__/*.mjs',
    ciJob: 'js-suites',
    skipParser: 'node',
  },
  { name: 'demo-worker', command: 'node', args: ['--test', 'services/demo-worker/test/*.test.js'], ci: 'node --test services/demo-worker/test/*.test.js', ciJob: 'js-suites', skipParser: 'node' },
  {
    name: 'tooling-tests',
    command: 'node',
    args: ['--test', 'tools/tests/ci-parity.test.mjs'],
    ci: 'node --test tools/tests/ci-parity.test.mjs',
    ciJob: 'js-suites',
    skipParser: 'node',
  },
  {
    name: 'tools',
    command: python,
    args: ['-m', 'unittest', 'discover', '-s', 'tools/tests', '-v'],
    ci: 'python3 -m unittest discover -s tools/tests -v',
    ciJob: 'js-suites',
    skipParser: 'unittest',
  },
  {
    name: 'panel',
    command: 'uv',
    args: ['run', '--with', 'pytest', 'pytest', 'apps/panel/tests', '-q'],
    ci: 'uv run --with pytest pytest apps/panel/tests -q',
    ciJob: 'panel-suite',
    skipParser: 'pytest',
  },
  { name: 'panel-checks', command: 'node', args: ['tools/run-panel-checks.mjs'], ci: 'node tools/run-panel-checks.mjs', ciJob: 'panel-suite' },
  {
    name: 'asr-worker',
    command: 'uv',
    args: ['run', '--project', 'services/asr-worker', '--with', 'pytest', '--with', 'httpx', 'pytest', 'services/asr-worker/tests', '-q'],
    ci: 'uv run --project services/asr-worker --with pytest --with httpx pytest services/asr-worker/tests -q',
    ciJob: 'python-suites',
    skipParser: 'pytest',
  },
  {
    name: 'tts-worker',
    command: 'uv',
    args: ['run', '--project', 'services/tts-worker', '--with', 'pytest', 'pytest', 'services/tts-worker/tests', '-q'],
    ci: 'uv run --project services/tts-worker --with pytest pytest services/tts-worker/tests -q',
    ciJob: 'python-suites',
    skipParser: 'pytest',
  },
  {
    name: 'worker-common',
    command: 'uv',
    args: ['run', '--project', 'packages/python/newsroom_worker_common', '--with', 'pytest', 'pytest', 'packages/python/newsroom_worker_common/tests', '-q'],
    ci: 'uv run --project packages/python/newsroom_worker_common --with pytest pytest packages/python/newsroom_worker_common/tests -q',
    ciJob: 'python-suites',
    skipParser: 'pytest',
  },
  {
    name: 'local-adapters',
    command: 'uv',
    args: ['run', '--project', 'packages/python/newsroom_local_adapters', '--with', 'pytest', '--with', 'python-docx', 'pytest', 'packages/python/newsroom_local_adapters/tests', '-q'],
    ci: 'uv run --project packages/python/newsroom_local_adapters --with pytest --with python-docx pytest packages/python/newsroom_local_adapters/tests -q',
    ciJob: 'python-suites',
    skipParser: 'pytest',
    nestedSkipAllowlist: [liveOptIn],
  },
  {
    name: 'channel-monitor',
    command: 'uv',
    args: ['run', '--project', 'services/channel-monitor', '--with', 'pytest', '--with', 'httpx', '--with', 'pyyaml', '--with', 'uvicorn', 'pytest', 'services/channel-monitor/tests', '-q'],
    ci: 'uv run --project services/channel-monitor --with pytest --with httpx --with pyyaml --with uvicorn pytest services/channel-monitor/tests -q',
    ciJob: 'python-suites',
    skipParser: 'pytest',
  },
  {
    name: 'subtitles',
    command: 'uv',
    args: ['run', '--project', 'services/subtitles', '--extra', 'translation', '--with', 'pytest', '--with', 'httpx', '--with', 'pyyaml', 'pytest', 'services/subtitles/tests', '-q'],
    ci: 'uv run --project services/subtitles --extra translation --with pytest --with httpx --with pyyaml pytest services/subtitles/tests -q',
    ciJob: 'python-suites',
    skipParser: 'pytest',
    nestedSkipAllowlist: [{ code: 'missing-torch', match: /torch/i }],
  },
  {
    name: 'installers',
    command: 'bash',
    args: ['infra/install/tests/run.sh'],
    ci: 'bash infra/install/tests/run.sh',
    ciJob: ['compose', 'linux-installers'],
    skipParser: 'unittest',
    nestedSkipAllowlist: [missingPwsh],
    skip: !hasCommand('bash') ? skip('missing-bash', 'bash is not available on this host') : null,
  },
  {
    name: 'installers-check',
    command: 'bash',
    args: ['install.sh', '--check'],
    ci: './install.sh --check',
    ciJob: 'linux-installers',
    skip: !hasCommand('bash') ? skip('missing-bash', 'bash is not available on this host')
      : !hasCommand('docker') ? skip('missing-docker', './install.sh --check needs Docker on this host') : null,
  },
  {
    name: 'installers-dry-run',
    command: 'bash',
    args: ['install.sh', '--yes', '--profile', 'cpu', '--dry-run', '--no-open'],
    ci: './install.sh --yes --profile cpu --dry-run --no-open',
    ciJob: 'linux-installers',
    skip: !hasCommand('bash') ? skip('missing-bash', 'bash is not available on this host') : null,
  },
  {
    name: 'compose-config',
    command: 'docker',
    args: ['compose', '--env-file', 'e2e/.env.example', '-f', 'compose.yaml', 'config', '-q'],
    ci: 'docker compose --env-file e2e/.env.example -f compose.yaml config -q',
    ciJob: 'compose',
    skip: !hasCommand('docker') ? skip('missing-docker', 'docker is not available on this host') : null,
  },
  {
    name: 'compose-config-gpu-n8n',
    command: 'docker',
    args: ['compose', '--env-file', 'e2e/.env.example', '--profile', 'gpu', '--profile', 'n8n', '-f', 'compose.yaml', 'config', '-q'],
    ci: 'docker compose --env-file e2e/.env.example --profile gpu --profile n8n -f compose.yaml config -q',
    ciJob: 'compose',
    skip: !hasCommand('docker') ? skip('missing-docker', 'docker is not available on this host') : null,
  },
  {
    name: 'compose-alias',
    command: 'node',
    args: ['-e', "process.exit(require('node:fs').existsSync('docker-compose.yml') ? 1 : 0)"],
    ci: 'test ! -e docker-compose.yml',
    ciJob: 'compose',
  },
  {
    name: 'visual-qa',
    command: 'node',
    args: ['tools/run-visual-qa.mjs'],
    ci: 'node tools/run-visual-qa.mjs',
    ciJob: 'visual-qa',
    skip: !existsSync('node_modules/.bin/playwright') ? skip('missing-playwright', 'Playwright is not installed (run pnpm install + playwright install chromium)') : null,
  },
  {
    name: 'e2e-demo',
    command: playwrightBin,
    args: ['test', 'e2e/happy-path.spec.js', 'e2e/panel-flows.spec.js'],
    ci: 'pnpm exec playwright test e2e/happy-path.spec.js e2e/panel-flows.spec.js',
    ciJob: 'e2e',
    skip: !wantE2E ? skip('needs-stack', 'set NEWSROOM_E2E=1 after starting the demo stack to run the Playwright E2E')
      : !existsSync(playwrightBin) ? skip('missing-playwright', 'Playwright is not installed (run pnpm install + playwright install chromium)') : null,
  },
  {
    name: 'e2e-local',
    command: playwrightBin,
    args: ['test', 'e2e/local-mode.spec.js'],
    ci: 'pnpm exec playwright test e2e/local-mode.spec.js',
    ciJob: 'local-e2e',
    skip: !wantLocalE2E ? skip('needs-stack', 'set NEWSROOM_E2E_LOCAL=1 after preparing the local stack to run this E2E')
      : !existsSync(playwrightBin) ? skip('missing-playwright', 'Playwright is not installed (run pnpm install + playwright install chromium)') : null,
  },
];

// The matrix is checked against the CI workflows in both directions: every
// step declares the whole command and job it mirrors, and every suite-like
// `run:` line in ci.yml/installers.yml must be represented here.
const workflowFiles = ['.github/workflows/ci.yml', '.github/workflows/installers.yml', '.github/workflows/local-mode.yml'];
const workflows = workflowFiles.map((file) => ({ file, text: readFileSync(file, 'utf8') }));
const parityProblems = findParityProblems({ steps, workflows });
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
  const tapDir = step.skipParser === 'node' ? mkdtempSync(join(tmpdir(), 'newsroom-test-tap-')) : null;
  const tapFile = tapDir ? join(tapDir, 'report.tap') : null;
  const args = [...step.args];
  if (tapFile && args[0] === '--test') {
    args.splice(
      1,
      0,
      '--test-reporter=spec',
      '--test-reporter-destination=stdout',
      '--test-reporter=tap',
      `--test-reporter-destination=${tapFile}`,
    );
  } else if (step.skipParser === 'pytest') {
    args.push('-rs');
  }
  const result = spawnSync(step.command, args, { encoding: 'utf8', shell: false });
  const duration = Date.now() - started;
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  const tapText = tapFile && existsSync(tapFile) ? readFileSync(tapFile, 'utf8') : '';
  if (tapDir) rmSync(tapDir, { recursive: true, force: true });

  if (result.error) {
    results.push({ name: step.name, status: 'FAIL', duration, reason: result.error.message });
    process.stdout.write(`FAIL  ${step.name} — ${result.error.message}\n`);
    continue;
  }
  const reasons = parseNestedSkips(step, result.stdout, result.stderr, tapText);
  const { groups, unexpected } = classifyNestedSkips(step, reasons);
  const nested = groups.map(([code, count]) => `${code}: ${count}`).join(', ');
  if (unexpected.length) {
    const reason = `unexpected nested skip(s): ${unexpected.join('; ')}`;
    results.push({ name: step.name, status: 'FAIL', duration, reason, nested });
    process.stdout.write(`FAIL  ${step.name} — ${reason}\n`);
    continue;
  }
  const status = result.status === 0 ? 'PASS' : 'FAIL';
  results.push({ name: step.name, status, duration, reason: '', nested });
  process.stdout.write(`${status}  ${step.name} (${formatDuration(duration)})${nested ? ` — nested skips ${nested}` : ''}\n`);
}

const failed = results.filter((result) => result.status === 'FAIL');
const skipped = results.filter((result) => result.status === 'SKIP');
const unexpectedSkips = skipped.filter((result) => !result.allowed);
const width = Math.max(...results.map((result) => result.name.length), 'suite'.length);
process.stdout.write(`\n${'suite'.padEnd(width)}  result  duration  details\n`);
process.stdout.write(`${'-'.repeat(width)}  ------  --------  -------\n`);
for (const result of results) {
  const details = [result.reason, result.nested ? `nested skips: ${result.nested}` : ''].filter(Boolean).join('; ');
  process.stdout.write(
    `${result.name.padEnd(width)}  ${result.status.padEnd(6)}  ${formatDuration(result.duration).padEnd(8)}  ${details}\n`,
  );
}
const passed = results.filter((result) => result.status === 'PASS').length;
const nestedTotal = results.reduce((total, result) => {
  if (!result.nested) return total;
  return total + result.nested.split(',').reduce((sum, part) => sum + Number(part.split(':')[1].trim()), 0);
}, 0);
process.stdout.write(`\n${passed}/${results.length} suites passed, ${failed.length} failed, ${skipped.length} skipped (${unexpectedSkips.length} unexpected), ${nestedTotal} nested skips reported\n`);
if (unexpectedSkips.length) {
  process.stderr.write('Unallow-listed skips: ' + unexpectedSkips.map((result) => result.name).join(', ') + '\n');
}
process.exit(failed.length === 0 && unexpectedSkips.length === 0 ? 0 : 1);
