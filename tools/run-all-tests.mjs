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
import { existsSync } from 'node:fs';
import { delimiter } from 'node:path';

const isWindows = process.platform === 'win32';
const python = isWindows ? 'python' : 'python3';
const wantE2E = process.env.NEWSROOM_E2E === '1' || process.argv.includes('--e2e');
const hasCommand = (name) => {
  const path = process.env.PATH || '';
  const extensions = isWindows ? ['', '.exe', '.cmd', '.bat'] : [''];
  return path.split(delimiter).some((dir) => extensions.some((ext) => existsSync(`${dir}/${name}${ext}`)));
};

const steps = [
  { name: 'core', command: 'node', args: ['--test', 'packages/core/test/*.test.js'] },
  { name: 'data', command: 'node', args: ['--test', 'packages/data/test/*.test.js'] },
  { name: 'contracts', command: 'node', args: ['--test', 'packages/contracts/test/*.test.js'] },
  { name: 'adapters', command: 'node', args: ['--test', 'packages/adapters/test/*.test.js'] },
  { name: 'api', command: 'node', args: ['--test', 'apps/api/test/*.test.js'] },
  { name: 'renderer', command: 'node', args: ['--test', 'services/renderer/tests/*.test.js'] },
  { name: 'demo-worker', command: 'node', args: ['--test', 'services/demo-worker/test/*.test.js'] },
  { name: 'tools', command: python, args: ['-m', 'unittest', 'discover', '-s', 'tools/tests', '-v'] },
  { name: 'panel', command: 'uv', args: ['run', '--with', 'pytest', 'pytest', 'apps/panel/tests', '-q'] },
  { name: 'panel-checks', command: 'node', args: ['tools/run-panel-checks.mjs'] },
  {
    name: 'asr-worker',
    command: 'uv',
    args: ['run', '--project', 'services/asr-worker', '--with', 'pytest', '--with', 'httpx', 'pytest', 'services/asr-worker/tests', '-q'],
  },
  {
    name: 'tts-worker',
    command: 'uv',
    args: ['run', '--project', 'services/tts-worker', '--with', 'pytest', 'pytest', 'services/tts-worker/tests', '-q'],
  },
  {
    name: 'worker-common',
    command: 'uv',
    args: ['run', '--project', 'packages/python/newsroom_worker_common', '--with', 'pytest', 'pytest', 'packages/python/newsroom_worker_common/tests', '-q'],
  },
  {
    name: 'local-adapters',
    command: 'uv',
    args: ['run', '--project', 'packages/python/newsroom_local_adapters', '--with', 'pytest', '--with', 'python-docx', 'pytest', 'packages/python/newsroom_local_adapters/tests', '-q'],
  },
  {
    name: 'channel-monitor',
    command: 'uv',
    args: ['run', '--project', 'services/channel-monitor', '--with', 'pytest', '--with', 'httpx', '--with', 'pyyaml', '--with', 'uvicorn', 'pytest', 'services/channel-monitor/tests', '-q'],
  },
  {
    name: 'subtitles',
    command: 'uv',
    args: ['run', '--project', 'services/subtitles', '--extra', 'translation', '--with', 'pytest', '--with', 'httpx', '--with', 'pyyaml', 'pytest', 'services/subtitles/tests', '-q'],
  },
  {
    name: 'installers',
    command: 'bash',
    args: ['infra/install/tests/run.sh'],
    skip: !hasCommand('bash') ? 'bash is not available on this host' : null,
  },
  {
    name: 'compose-config',
    command: 'docker',
    args: ['compose', '--env-file', 'e2e/.env.example', '-f', 'compose.yaml', 'config', '-q'],
    skip: !hasCommand('docker') ? 'docker is not available on this host' : null,
  },
  {
    name: 'compose-config-gpu-n8n',
    command: 'docker',
    args: ['compose', '--env-file', 'e2e/.env.example', '--profile', 'gpu', '--profile', 'n8n', '-f', 'compose.yaml', 'config', '-q'],
    skip: !hasCommand('docker') ? 'docker is not available on this host' : null,
  },
  {
    name: 'e2e-demo',
    command: 'pnpm',
    args: ['exec', 'playwright', 'test'],
    skip: wantE2E ? null : 'set NEWSROOM_E2E=1 after starting the demo stack to run the Playwright E2E',
  },
];

function formatDuration(ms) {
  return `${(ms / 1000).toFixed(1)}s`;
}

const results = [];
for (const step of steps) {
  if (step.skip) {
    results.push({ name: step.name, status: 'SKIP', duration: 0, reason: step.skip });
    process.stdout.write(`SKIP  ${step.name} — ${step.skip}\n`);
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
const width = Math.max(...results.map((result) => result.name.length), 'suite'.length);
process.stdout.write(`\n${'suite'.padEnd(width)}  result  duration  details\n`);
process.stdout.write(`${'-'.repeat(width)}  ------  --------  -------\n`);
for (const result of results) {
  process.stdout.write(
    `${result.name.padEnd(width)}  ${result.status.padEnd(6)}  ${formatDuration(result.duration).padEnd(8)}  ${result.reason || ''}\n`,
  );
}
process.stdout.write(`\n${results.length - failed.length}/${results.length} suites passed, ${failed.length} failed\n`);
process.exit(failed.length === 0 ? 0 : 1);
