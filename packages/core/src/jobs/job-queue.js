import { randomUUID } from 'node:crypto';

/**
 * In-process job queue. The default concurrency is one because the local
 * product has a single GPU slot; handlers can still be composed per stage.
 */
export class JobQueue {
  #concurrency;
  #handlers;
  #logger;
  #jobs = [];
  #pending = [];
  #active = 0;
  #waiters = [];

  constructor({ concurrency = 1, handlers = {}, logger = console } = {}) {
    const value = Number(concurrency);
    if (!Number.isSafeInteger(value) || value <= 0) throw new Error('concurrency must be a positive integer');
    this.#concurrency = value;
    this.#handlers = { ...handlers };
    this.#logger = logger;
  }

  register(name, handler) {
    if (!name || typeof handler !== 'function') throw new Error('name and handler are required');
    this.#handlers[name] = handler;
  }

  enqueue(name, payload = {}) {
    if (!this.#handlers[name]) throw new Error(`no handler registered for job: ${name}`);
    const job = {
      id: randomUUID(),
      name,
      payload,
      status: 'queued',
      result: null,
      error: null,
      queued_at: new Date().toISOString(),
      started_at: null,
      finished_at: null,
    };
    this.#jobs.push(job);
    this.#pending.push(job);
    void this.#pump();
    return job;
  }

  list() {
    return this.#jobs.map((job) => ({ ...job }));
  }

  get size() {
    return this.#pending.length + this.#active;
  }

  drain() {
    if (this.size === 0) return Promise.resolve(this.list());
    return new Promise((resolve) => {
      this.#waiters.push(resolve);
    });
  }

  async #pump() {
    while (this.#active < this.#concurrency && this.#pending.length) {
      const job = this.#pending.shift();
      this.#active += 1;
      job.status = 'running';
      job.started_at = new Date().toISOString();
      void this.#run(job);
    }
    if (this.size === 0) this.#flush();
  }

  async #run(job) {
    try {
      job.result = await this.#handlers[job.name](job.payload, job);
      job.status = 'completed';
    } catch (error) {
      job.status = 'failed';
      job.error = String(error?.message || error);
      this.#logger?.error?.('job failed', { job: job.name, id: job.id, error: job.error });
    } finally {
      job.finished_at = new Date().toISOString();
      this.#active -= 1;
      void this.#pump();
    }
  }

  #flush() {
    const waiters = this.#waiters.splice(0);
    for (const resolve of waiters) resolve(this.list());
  }
}
