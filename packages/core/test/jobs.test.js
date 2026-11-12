import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { JobQueue, Scheduler } from '../src/index.js';

function waitFor(predicate, { timeoutMs = 2000, intervalMs = 5 } = {}) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      if (predicate()) {
        resolve();
        return;
      }
      if (Date.now() - started > timeoutMs) {
        reject(new Error('waitFor timeout'));
        return;
      }
      setTimeout(tick, intervalMs);
    };
    tick();
  });
}

describe('JobQueue', () => {
  it('runs jobs serially and records terminal status', async () => {
    let active = 0;
    let maxActive = 0;
    const order = [];
    const queue = new JobQueue({
      concurrency: 1,
      handlers: {
        async demo(payload) {
          active += 1;
          maxActive = Math.max(maxActive, active);
          order.push(payload.id);
          await new Promise((resolve) => setTimeout(resolve, 5));
          active -= 1;
          return payload.id;
        },
      },
    });

    queue.enqueue('demo', { id: 1 });
    queue.enqueue('demo', { id: 2 });
    queue.enqueue('demo', { id: 3 });
    await queue.drain();

    assert.equal(maxActive, 1);
    assert.deepEqual(order, [1, 2, 3]);
    assert.deepEqual(queue.list().map((job) => job.status), ['completed', 'completed', 'completed']);
  });

  it('marks failed jobs and keeps processing the rest', async () => {
    const queue = new JobQueue({
      concurrency: 1,
      handlers: {
        async ok() { return 'ok'; },
        async fail() { throw new Error('boom'); },
      },
    });
    queue.enqueue('fail', {});
    queue.enqueue('ok', {});
    await queue.drain();
    const jobs = queue.list();
    assert.equal(jobs[0].status, 'failed');
    assert.match(jobs[0].error, /boom/);
    assert.equal(jobs[1].status, 'completed');
  });

  it('rejects unknown handlers', async () => {
    const queue = new JobQueue({ handlers: {} });
    assert.throws(() => queue.enqueue('missing', {}), /handler/i);
  });
});

describe('Scheduler', () => {
  it('runs registered tasks at their interval and stops cleanly', async () => {
    let runs = 0;
    const scheduler = new Scheduler({ now: () => 0 });
    scheduler.register('demo', {
      everyMs: 1000,
      async handler() { runs += 1; },
    });
    scheduler.start();
    await waitFor(() => runs >= 1);
    scheduler.stop();
    const afterStop = runs;
    await new Promise((resolve) => setTimeout(resolve, 120));
    assert.equal(runs, afterStop);
  });

  it('validates the interval and task names', () => {
    const scheduler = new Scheduler();
    assert.throws(() => scheduler.register('', { everyMs: 1000, handler() {} }), /name/i);
    assert.throws(() => scheduler.register('x', { everyMs: 0, handler() {} }), /everyMs/i);
    assert.throws(() => scheduler.register('y', { everyMs: 10 }), /handler/i);
  });
});
