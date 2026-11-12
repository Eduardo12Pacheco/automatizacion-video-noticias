import { spawn as nodeSpawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { AdapterError } from './http.js';

export const DEFAULT_ADAPTER_SCRIPT = fileURLToPath(
  new URL('../../python/newsroom_local_adapters/newsroom_local_adapters/cli.py', import.meta.url),
);

function parseLastJsonLine(text) {
  const lines = String(text || '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    try {
      return JSON.parse(lines[index]);
    } catch {
      // Keep looking: Python may print a warning before the JSON contract.
    }
  }
  return null;
}

export function runJsonCommand({
  pythonBin = 'python3',
  scriptPath = DEFAULT_ADAPTER_SCRIPT,
  args = [],
  payload = null,
  timeoutMs = 120_000,
  spawnImpl = nodeSpawn,
  env = process.env,
} = {}) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawnImpl(pythonBin, [scriptPath, ...args], {
        stdio: ['pipe', 'pipe', 'pipe'],
        env,
      });
    } catch (error) {
      reject(new AdapterError('adapter_spawn_failed', `Could not start ${pythonBin}: ${error?.message || error}`));
      return;
    }
    let stdout = '';
    let stderr = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill?.('SIGKILL');
      reject(new AdapterError('adapter_timeout', `Local adapter timed out after ${timeoutMs} ms`));
    }, Math.max(1, Number(timeoutMs) || 120_000));

    child.stdout?.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr?.on('data', (chunk) => { stderr += chunk.toString(); });
    child.on?.('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new AdapterError('adapter_spawn_failed', `Could not start ${pythonBin}: ${error?.message || error}`));
    });
    child.on?.('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const parsed = parseLastJsonLine(stdout);
      if (code === 0 && parsed) {
        resolve(parsed);
        return;
      }
      const errorPayload = parseLastJsonLine(stderr);
      const errorCode = String(errorPayload?.error || 'adapter_failed');
      const message = String(errorPayload?.message || stderr.trim() || `Local adapter exited with code ${code}`);
      reject(new AdapterError(errorCode, message));
    });
    if (payload !== null && payload !== undefined) {
      child.stdin?.end(JSON.stringify(payload));
    } else {
      child.stdin?.end();
    }
  });
}
