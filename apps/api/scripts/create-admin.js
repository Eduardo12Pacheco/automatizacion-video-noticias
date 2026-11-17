#!/usr/bin/env node
/**
 * First-admin bootstrap for the local install.
 *
 * Runs inside the API container after the migrations:
 *   node scripts/create-admin.js --email admin@example.local --password-stdin
 *
 * The password is read from stdin or NEWSROOM_ADMIN_PASSWORD, never from argv,
 * so it does not leak into shell history or the process list.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { PostgresRepository } from '@newsroom/data';

import { ensureAdminUser } from '../src/create-admin.js';

const USAGE = `Usage: node scripts/create-admin.js --email <email> [options]

Options:
  --email <email>          Administrator email (required)
  --display-name <name>    Display name (defaults to the email)
  --password-stdin         Read the password from stdin
  --reset-password         Reset the password of an existing account
  --help                   Show this help

Environment:
  DATABASE_URL             Postgres connection string (required)
  NEWSROOM_ADMIN_PASSWORD  Password when --password-stdin is not used
`;

export function parseArgs(argv = []) {
  const options = {
    email: '',
    displayName: '',
    passwordStdin: false,
    resetPassword: false,
    help: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = String(argv[index]);
    if (arg === '--help' || arg === '-h') {
      options.help = true;
    } else if (arg === '--email') {
      options.email = String(argv[++index] || '');
    } else if (arg.startsWith('--email=')) {
      options.email = arg.slice('--email='.length);
    } else if (arg === '--display-name') {
      options.displayName = String(argv[++index] || '');
    } else if (arg.startsWith('--display-name=')) {
      options.displayName = arg.slice('--display-name='.length);
    } else if (arg === '--password-stdin') {
      options.passwordStdin = true;
    } else if (arg === '--reset-password') {
      options.resetPassword = true;
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return options;
}

function readPassword({ passwordStdin }) {
  if (passwordStdin) return readFileSync(0, 'utf8').replace(/\r?\n$/, '');
  return process.env.NEWSROOM_ADMIN_PASSWORD || '';
}

export async function main(argv = process.argv.slice(2), { repositoryFactory, stdout = process.stdout } = {}) {
  const options = parseArgs(argv);
  if (options.help) {
    stdout.write(USAGE);
    return 0;
  }
  if (!options.email) throw new Error('--email is required');
  const password = readPassword(options);
  if (!password) {
    throw new Error('a password is required: use --password-stdin or NEWSROOM_ADMIN_PASSWORD');
  }

  const repository = repositoryFactory
    ? repositoryFactory()
    : new PostgresRepository({ connectionString: process.env.DATABASE_URL });
  try {
    const result = await ensureAdminUser({
      repository,
      email: options.email,
      displayName: options.displayName,
      password,
      resetPassword: options.resetPassword,
    });
    stdout.write(`${JSON.stringify({
      ok: true,
      created: result.created,
      password_changed: result.password_changed,
      user: {
        user_id: result.user?.user_id,
        email: result.user?.email,
        display_name: result.user?.display_name,
        roles: result.user?.roles,
      },
    })}\n`);
    return 0;
  } finally {
    if (typeof repository.close === 'function') await repository.close();
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().then((code) => {
    process.exitCode = code;
  }).catch((error) => {
    process.stderr.write(`create-admin: ${error?.message || error}\n`);
    process.exitCode = 1;
  });
}
