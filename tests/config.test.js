import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, statSync, symlinkSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { captainPaths, loadConfig, saveConfig, validateConfig } from '../src/config.js';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'captain-config-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return join(root, 'captain.json');
}

test('configuration defaults to no launch permission and resolves agent directory overrides', t => {
  assert.deepEqual(loadConfig(fixture(t)), { version: 1, workspaces: { allow: [], exclude: [] },
    reporting: { progress: false, verbosity: 'brief' } });
  assert.equal(captainPaths({}, '/home/example').configFile, '/home/example/.pi/agent/captain.json');
  assert.equal(captainPaths({ PI_CODING_AGENT_DIR: '~/agent' }, '/home/example').agentDir, '/home/example/agent');
});

test('workspace and reporting preferences persist privately without mutating the caller', t => {
  const file = fixture(t);
  const settings = { workspaces: { allow: ['~/Development/**', '~/.nixos', '~/.nixos'], exclude: [] },
    reporting: { progress: true, verbosity: 'detailed' } };
  const config = saveConfig(file, settings);
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.deepEqual(loadConfig(file), config);
  assert.deepEqual(config.workspaces.allow, ['~/Development/**', '~/.nixos']);
  assert.equal(settings.workspaces.allow.length, 3);
});

test('configuration corruption, unknown keys and invalid types fail closed', t => {
  const file = fixture(t);
  for (const value of [{ version: 2 }, { workspaces: { allow: 'anywhere' } },
    { workspaces: { allow: ['relative/path'] } }, { workspaces: { allow: ['/tmp\nunsafe'] } },
    { reporting: { progress: 'yes' } }, { reporting: { verbosity: 'maximum' } }, { unexpected: true },
    { workspaces: { allowed: ['/tmp'] } }, { workspaces: { allow: ['/tmp/{a,b}'] } }, [], null]) assert.throws(() => validateConfig(value));
  writeFileSync(file, '{');
  assert.throws(() => loadConfig(file));
  writeFileSync(file, ' '.repeat(65537));
  assert.throws(() => loadConfig(file), /too large/);
});

test('oversized settings cannot replace a valid readable configuration', t => {
  const file = fixture(t);
  const original = saveConfig(file, { workspaces: { allow: ['~/.nixos'] } });
  const before = readFileSync(file, 'utf8');
  const allow = Array.from({ length: 64 }, (_, index) => `/tmp/${index}-${'x'.repeat(1100)}`);
  assert.throws(() => saveConfig(file, { workspaces: { allow } }), /too large/);
  assert.equal(readFileSync(file, 'utf8'), before);
  assert.deepEqual(loadConfig(file), original);
});

test('declarative symlink configs can be read but are never overwritten', t => {
  const file = fixture(t);
  const source = `${file}.source`;
  writeFileSync(source, JSON.stringify({ workspaces: { allow: ['~/.nixos'] } }));
  symlinkSync(source, file);
  assert.deepEqual(loadConfig(file).workspaces.allow, ['~/.nixos']);
  assert.throws(() => saveConfig(file, {}), /declarative/);
  assert.deepEqual(JSON.parse(readFileSync(source, 'utf8')).workspaces.allow, ['~/.nixos']);
});
