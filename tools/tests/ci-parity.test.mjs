import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { SUITE_COMMAND, extractRunCommands, findParityProblems } from '../lib/ci-parity.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const readWorkflow = (file) => ({ file, text: readFileSync(join(ROOT, file), 'utf8') });
const readAllWorkflows = () => [
  readWorkflow('.github/workflows/ci.yml'),
  readWorkflow('.github/workflows/installers.yml'),
  readWorkflow('.github/workflows/local-mode.yml'),
];
const DEMO_E2E = 'pnpm exec playwright test e2e/happy-path.spec.js e2e/panel-flows.spec.js';
const LOCAL_E2E = 'pnpm exec playwright test e2e/local-mode.spec.js';

test('removing the demo E2E step from a workflow copy is reported', () => {
  const workflows = readAllWorkflows().map((workflow) => ({
    ...workflow,
    text: workflow.text.replace(`${DEMO_E2E}\n`, ''),
  }));
  const problems = findParityProblems({
    steps: [{ name: 'e2e-demo', ci: DEMO_E2E, ciJob: 'e2e' }],
    workflows,
  });

  assert.ok(problems.includes('e2e-demo: CI no longer runs "pnpm exec playwright test e2e/happy-path.spec.js e2e/panel-flows.spec.js" in job "e2e"'));
});

test('a shorter command is not satisfied by a longer command in another job', () => {
  const workflows = readAllWorkflows();
  const problems = findParityProblems({
    steps: [{ name: 'e2e-demo', ci: 'pnpm exec playwright test', ciJob: 'e2e' }],
    workflows,
  });

  assert.ok(problems.some((problem) => problem.includes('e2e-demo: CI no longer runs')), 'substring matching must not pass');
  assert.ok(problems.some((problem) => problem.includes(`-> ${DEMO_E2E}`)), 'the demo line must be reported as uncovered');
});

test('a step cannot claim a command that exists only in a different job', () => {
  const workflows = readAllWorkflows();
  const problems = findParityProblems({
    steps: [{ name: 'e2e-local', ci: LOCAL_E2E, ciJob: 'e2e' }],
    workflows,
  });

  assert.ok(problems.some((problem) => problem.includes('e2e-local: CI no longer runs')), 'job names are part of the contract');
});

test('block scalars yield whole command lines and their job names', () => {
  const commands = extractRunCommands(readWorkflow('.github/workflows/ci.yml').text);
  const localCommands = extractRunCommands(readWorkflow('.github/workflows/local-mode.yml').text);

  assert.ok(commands.some((entry) => entry.job === 'e2e' && entry.command === DEMO_E2E));
  assert.ok(localCommands.some((entry) => entry.job === 'local-e2e' && entry.command === LOCAL_E2E));
  assert.ok([...commands, ...localCommands].every((entry) => !entry.command.includes('\n')));
});

test('every suite command in the workflows is covered by the declared steps', () => {
  const workflows = readAllWorkflows();
  const covered = new Set(
    workflows.flatMap((workflow) =>
      extractRunCommands(workflow.text)
        .map((entry) => entry.command)
        .filter((command) => SUITE_COMMAND.test(command)),
    ),
  );
  const steps = [...covered]
    .filter((command) => !command.startsWith('python -m unittest discover -s infra/install/tests'))
    .map((command, index) => ({ name: `step-${index}`, ci: command }));

  assert.deepEqual(findParityProblems({ steps, workflows }), []);
});

import { classifyNestedSkips, parseNestedSkips } from '../lib/nested-skips.mjs';

test('unittest nested skips keep their printed reason and allow-list code', () => {
  const step = { skipParser: 'unittest', nestedSkipAllowlist: [{ code: 'missing-pwsh', match: /pwsh\/powershell is not installed/ }] };
  const output = "test_install_ps1 (unittest.loader._FailedTest) ... skipped 'pwsh/powershell is not installed'\nOK (skipped=27)";
  const reasons = parseNestedSkips(step, output, '', '');

  assert.equal(reasons.length, 1);
  const result = classifyNestedSkips(step, reasons);
  assert.deepEqual(result.groups, [['missing-pwsh', 1]]);
  assert.deepEqual(result.unexpected, []);
});

test('an undeclared nested skip fails classification', () => {
  const step = { skipParser: 'pytest', nestedSkipAllowlist: [] };
  const output = 'SKIPPED [1] tests/test_x.py:12: torch is not installed\n1 skipped in 0.1s';

  assert.deepEqual(parseNestedSkips(step, output, '', ''), ['torch is not installed']);
  assert.deepEqual(classifyNestedSkips(step, ['torch is not installed']).unexpected, ['torch is not installed']);
});

test('node TAP reports every skipped test reason', () => {
  const step = { skipParser: 'node', nestedSkipAllowlist: [{ code: 'live-opt-in', match: /^set / }] };
  const tap = 'ok 1 - live check # SKIP set NEWSROOM_LIVE_TESTS=1 to run\nok 2 - other # SKIP set S3_TEST_ENDPOINT to run\n# skipped 2';
  const reasons = parseNestedSkips(step, '', '', tap);

  assert.equal(reasons.length, 2);
  assert.deepEqual(classifyNestedSkips(step, reasons).groups, [['live-opt-in', 2]]);
});
