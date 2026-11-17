import { existsSync, readFileSync } from 'node:fs';

/**
 * Shared helpers for the Playwright specs that drive a Compose stack.
 *
 * The manual demo flow must never copy `e2e/.env.example` over an installed
 * `.env`. Instead the caller points `E2E_COMPOSE_ENV` at the environment file
 * the stack was started with; without it we fall back to the checked-out `.env`
 * (installed stack) and finally to the committed E2E template.
 */
export function resolveEnvFile() {
  if (process.env.E2E_COMPOSE_ENV) return process.env.E2E_COMPOSE_ENV;
  if (existsSync('.env')) return '.env';
  if (existsSync('e2e/.env.example')) return 'e2e/.env.example';
  return '';
}

export function readEnvValue(key, file = resolveEnvFile()) {
  if (!file || !existsSync(file)) return '';
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match || match[1] !== key) continue;
    return match[2].trim().replace(/^"(.*)"$/, '$1');
  }
  return '';
}

export function editorPassword() {
  return process.env.E2E_EDITOR_PASSWORD
    || readEnvValue('NEWSROOM_DEMO_PASSWORD')
    || 'e2e-demo-password';
}

export function composeArgs(args) {
  const envFile = resolveEnvFile();
  return ['compose', ...(envFile ? ['--env-file', envFile] : []), ...args];
}

export function composeEnv(overrides = {}) {
  const envFile = resolveEnvFile();
  const env = { ...process.env };
  // A key exported in the calling shell would win over the env file during
  // Compose interpolation. Strip the keys the file owns so the stack under
  // test always uses the configuration it was started with.
  if (envFile && existsSync(envFile)) {
    for (const line of readFileSync(envFile, 'utf8').split(/\r?\n/)) {
      const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)=/);
      if (match) delete env[match[1]];
    }
  }
  if (envFile) env.NEWSROOM_ENV_FILE = envFile;
  return { ...env, ...overrides };
}

/**
 * `panel-flows.spec.js` resets the seeded story and the administrator password.
 * Demand an explicit opt-in so the suite can never wipe a real installation.
 */
export function requireDisposableDemoStack() {
  if (process.env.E2E_ALLOW_RESET !== '1') {
    throw new Error(
      'refusing to reset the demo stack: set E2E_ALLOW_RESET=1 only for a '
      + 'disposable demo stack started for the E2E suite',
    );
  }
}
