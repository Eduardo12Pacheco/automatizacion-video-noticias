/**
 * Dependency-free interval scheduler for recurring local tasks. Handlers run
 * one tick at a time per task; a slow handler never overlaps itself.
 */
export class Scheduler {
  #tasks = new Map();
  #timer = null;
  #running = new Set();
  #logger;

  constructor({ logger = console } = {}) {
    this.#logger = logger;
  }

  register(name, { everyMs, handler, runOnStart = true } = {}) {
    if (!name || typeof name !== 'string') throw new Error('task name is required');
    const interval = Number(everyMs);
    if (!Number.isSafeInteger(interval) || interval <= 0) throw new Error('everyMs must be a positive integer');
    if (typeof handler !== 'function') throw new Error('handler is required');
    if (this.#tasks.has(name)) throw new Error(`task already registered: ${name}`);
    this.#tasks.set(name, { everyMs: interval, handler, runOnStart, lastRun: 0 });
  }

  start() {
    if (this.#timer) return;
    for (const task of this.#tasks.values()) {
      if (task.runOnStart) void this.#run('startup', task);
    }
    this.#timer = setInterval(() => void this.tick(), this.#smallestInterval());
  }

  stop() {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
  }

  async tick(now = Date.now()) {
    for (const [name, task] of this.#tasks.entries()) {
      if (this.#running.has(name)) continue;
      if (now - task.lastRun < task.everyMs) continue;
      task.lastRun = now;
      void this.#run(name, task);
    }
  }

  async #run(name, task) {
    this.#running.add(name);
    try {
      await task.handler();
    } catch (error) {
      this.#logger?.error?.('scheduled task failed', { task: name, error: String(error?.message || error) });
    } finally {
      this.#running.delete(name);
    }
  }

  #smallestInterval() {
    return Math.min(...[...this.#tasks.values()].map((task) => task.everyMs), 60_000);
  }
}
