#!/usr/bin/env node
/**
 * Run every executable panel __checks__ entry point.
 *
 * The check scripts are ESM modules, Node test files and small CLIs. Their
 * declaration in apps/panel/js/modules/__checks__/manifest.js records which
 * command kind each one needs. This runner is shared by CI and `pnpm test:all`
 * so local runs and CI exercise exactly the same set.
 */
import { spawnSync } from 'node:child_process';
import { readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PANEL = join(ROOT, 'apps', 'panel');
const MANIFEST = await import(pathToFileURL(join(PANEL, 'js/modules/__checks__/manifest.js')).href);
const commandKindByPath = new Map(MANIFEST.CHECK_MANIFEST.map((entry) => [entry.path, entry.commandKind]));

function walk(dir, out = []) {
  for (const name of readdirSync(dir).sort()) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      if (name === 'node_modules') continue;
      walk(full, out);
    } else {
      out.push(full);
    }
  }
  return out;
}

function findChecks(dir, out = []) {
  for (const name of readdirSync(dir).sort()) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      if (name === 'node_modules') continue;
      if (name === '__checks__') {
        walk(full, out);
      } else {
        findChecks(full, out);
      }
    }
  }
  return out;
}

function commandFor(full) {
  const relativePath = relative(PANEL, full).split('\\').join('/');
  const kind = commandKindByPath.get(relativePath);
  const base = relativePath.split('/').pop();
  if (kind === 'node-test' || /\.check\.m?js$/.test(base)) {
    return { command: process.execPath, args: ['--test', relativePath], label: 'node --test' };
  }
  if (kind === 'module-import') {
    const url = pathToFileURL(full).href;
    return {
      command: process.execPath,
      args: ['--input-type=module', '-e', `await import(${JSON.stringify(url)});`],
      label: 'import',
    };
  }
  return { command: process.execPath, args: [relativePath], label: 'node' };
}

const checks = findChecks(PANEL)
  .filter((full) => !full.endsWith('/__checks__/manifest.js') && !full.endsWith('\\__checks__\\manifest.js'))
  .sort();

let failed = 0;
for (const full of checks) {
  const relativePath = relative(ROOT, full);
  const { command, args, label } = commandFor(full);
  const result = spawnSync(command, args, { cwd: PANEL, encoding: 'utf8' });
  const ok = result.status === 0;
  if (!ok) failed += 1;
  process.stdout.write(`${ok ? 'PASS' : 'FAIL'}  ${relativePath}  (${label})\n`);
  if (!ok) {
    process.stdout.write(`${result.stdout || ''}${result.stderr || ''}\n`);
  }
}

process.stdout.write(`\npanel checks: ${checks.length - failed}/${checks.length} passed\n`);
process.exit(failed === 0 ? 0 : 1);
