#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
const ecosystem = (await import(pathToFileURL(path.join(repoRoot, 'ecosystem.config.cjs')))).default;
const apps = ecosystem.apps || [];
const names = apps.map((app) => app.name);
const expected = [
  'elecio-api',
  'elecio-panel',
  'elecio-telegram-bot',
  'elecio-outbox',
  'elecio-retry',
  'elecio-media',
  'elecio-cleanup',
  'elecio-youtube',
  'elecio-linkedin',
  'elecio-telegram-publisher',
  'elecio-aparat',
];

for (const name of expected) {
  assert.equal(names.filter((candidate) => candidate === name).length, 1, `${name} must exist exactly once`);
}
assert.equal(names.some((name) => /instagram/i.test(name)), false, 'Instagram must not be in default production PM2 apps');
assert.equal(names.some((name) => /bale/i.test(name)), false, 'Bale must not be in default production PM2 apps');

for (const app of apps) {
  assert.equal(app.namespace, 'elecio-publisher', `${app.name} namespace`);
  assert.equal(app.instances, 1, `${app.name} instances`);
  assert.equal(app.exec_mode, 'fork', `${app.name} exec_mode`);
  assert.equal(app.watch, false, `${app.name} watch`);
  assert.equal(app.env_production?.NODE_ENV, 'production', `${app.name} NODE_ENV`);
}

for (const app of apps.filter((app) => app.cwd === './apps/core')) {
  if (app.script.startsWith('dist/')) {
    const srcEquivalent = app.script.replace(/^dist\//, 'src/').replace(/\.js$/, '.js');
    assert.ok(fs.existsSync(path.join(repoRoot, 'apps/core', srcEquivalent)), `${app.name} source entry exists`);
  }
}

const cutover = fs.readFileSync(path.join(repoRoot, 'scripts/production/telegram-cutover-local.mjs'), 'utf8');
assert.match(cutover, /logOut\(\)/, 'cutover script contains explicit logOut call');
assert.match(cutover, /readline/, 'cutover script requires operator confirmation');
assert.doesNotMatch(cutover, /setInterval|setTimeout\([^)]*logOut/s, 'cutover must not schedule repeated logOut');

console.log('PASS production config validation');
