import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, lstatSync, mkdtempSync, readFileSync, writeFileSync, statSync, symlinkSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { captainPaths, loadConfig, saveConfig, validateConfig } from '../src/config.ts';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'captain-config-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return join(root, 'paj.json');
}

test('configuration defaults to no launch permission and resolves agent directory overrides', t => {
  assert.deepEqual(loadConfig(fixture(t)), { version: 1, workspaces: { allow: [], exclude: [] },
    reporting: { progress: false, verbosity: 'brief' } });
  assert.equal(captainPaths({}, '/home/example').configFile, '/home/example/.pi/agent/paj.json');
  assert.equal(captainPaths({}, '/home/example').stateDir, '/home/example/.pi/agent/captain/sessions');
  assert.equal(captainPaths({ PI_CODING_AGENT_DIR: '~/agent' }, '/home/example').configFile, '/home/example/agent/paj.json');
});

test('workspace and reporting preferences persist privately without mutating the caller', t => {
  const file = fixture(t);
  const settings = { workspaces: { allow: ['~/Development/**', '~/.nixos', '~/.nixos'], exclude: [] },
    reporting: { progress: true, verbosity: 'detailed' } };
  const config = saveConfig(file, settings);
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.deepEqual(loadConfig(file), config);
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { captain: config });
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

test('missing Captain sections default safely without inspecting opaque siblings or legacy files', t => {
  const file = fixture(t);
  const defaults = validateConfig({});
  writeFileSync(join(file, '..', 'captain.json'), JSON.stringify({ workspaces: { allow: ['/legacy/**'] } }));
  assert.deepEqual(loadConfig(file), defaults);
  for (const root of [{}, { subagents: null, voice: false, future: [1, 'value', null] },
    { version: 1, workspaces: { allow: ['/old-root/**'] } }]) {
    writeFileSync(file, JSON.stringify(root));
    assert.deepEqual(loadConfig(file), defaults);
  }
  const explicit = `${file}.custom`;
  writeFileSync(explicit, JSON.stringify({ captain: { reporting: { progress: true } }, voice: 12 }));
  assert.equal(loadConfig(explicit).reporting.progress, true);
});

test('only the Captain section is validated and explicit invalid sections fail closed', t => {
  const file = fixture(t);
  for (const captain of [null, [], true, 1, 'settings', { unknown: true }, { version: 2 },
    { reporting: { progress: 'yes' } }]) {
    writeFileSync(file, JSON.stringify({ captain, subagents: { unknown: 'opaque' } }));
    assert.throws(() => loadConfig(file));
  }
  writeFileSync(file, JSON.stringify({ captain: {}, subagents: { unknown: 'opaque' }, voice: [] }));
  assert.deepEqual(loadConfig(file), validateConfig({}));
});

test('repeated saves preserve every freshest sibling JSON value and replace only Captain', t => {
  const file = fixture(t);
  const siblings = { subagents: { models: ['one', 'two'] }, voice: { enabled: false },
    future: [null, false, 42, 'text', { nested: [] }], arbitrary: null, ['__proto__']: { retained: true } };
  writeFileSync(file, JSON.stringify(siblings));
  const first = saveConfig(file, { reporting: { progress: true } });
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { ...siblings, captain: first });
  const fresh = JSON.parse(readFileSync(file, 'utf8'));
  fresh.voice = { enabled: true, futureSetting: ['new'] };
  fresh.anotherAddon = 'preserved';
  writeFileSync(file, JSON.stringify(fresh));
  const second = saveConfig(file, { workspaces: { allow: ['/projects/**'] } });
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { ...fresh, captain: second });
  assert.deepEqual(loadConfig(file), second);
});

test('malformed shared roots are never overwritten and shared size limits include siblings', t => {
  const file = fixture(t);
  for (const raw of ['{', 'null', '[]', 'true', '42', '"settings"', ' '.repeat(65537)]) {
    writeFileSync(file, raw);
    assert.throws(() => loadConfig(file));
    assert.throws(() => saveConfig(file, {}));
    assert.equal(readFileSync(file, 'utf8'), raw);
  }
  const raw = JSON.stringify({ voice: 'x'.repeat(65500) });
  writeFileSync(file, raw);
  assert.deepEqual(loadConfig(file), validateConfig({}));
  assert.throws(() => saveConfig(file, {}), /too large/);
  assert.equal(readFileSync(file, 'utf8'), raw);
});

test('declarative symlink configs can be read but are never overwritten', t => {
  const file = fixture(t);
  const source = `${file}.source`;
  writeFileSync(source, JSON.stringify({ captain: { workspaces: { allow: ['~/.nixos'] } }, voice: { enabled: false } }));
  symlinkSync(source, file);
  assert.deepEqual(loadConfig(file).workspaces.allow, ['~/.nixos']);
  assert.throws(() => saveConfig(file, {}), /declarative/);
  assert.deepEqual(JSON.parse(readFileSync(source, 'utf8')),
    { captain: { workspaces: { allow: ['~/.nixos'] } }, voice: { enabled: false } });
  assert.equal(readFileSync(file, 'utf8'), readFileSync(source, 'utf8'));
  assert.equal(lstatSync(file).isSymbolicLink(), true);
});

test('dangling declarative symlinks cannot be replaced or written through', t => {
  const file = fixture(t);
  const source = `${file}.missing`;
  symlinkSync(source, file);
  assert.throws(() => saveConfig(file, {}), /declarative/);
  assert.equal(lstatSync(file).isSymbolicLink(), true);
  assert.equal(existsSync(source), false);
});
