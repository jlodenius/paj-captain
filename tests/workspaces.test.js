import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, symlinkSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { resolveWorkspace, listWorkspaces } from '../src/workspaces.ts';

function fixture(t) {
  const home = mkdtempSync(path.join(tmpdir(), 'captain-workspaces-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const make = relative => { const dir = path.join(home, relative); mkdirSync(dir, { recursive: true }); return dir; };
  return { home, make, policy: { allow: ['~/Development/**', '~/.nixos'], exclude: ['~/Development/private/**'] } };
}

test('resolves only existing exact directories; recursive allow and exclude wins', t => {
  const { home, make, policy } = fixture(t);
  const project = make('Development/team/project');
  make('Development/private/secret');
  make('.nixos');
  assert.equal(resolveWorkspace(project, policy, { home }), project);
  assert.equal(resolveWorkspace('team/project', policy, { home, base: path.join(home, 'Development') }), project);
  assert.equal(resolveWorkspace('~/.nixos', policy, { home }), path.join(home, '.nixos'));
  assert.equal(resolveWorkspace('~/Development', policy, { home }), path.join(home, 'Development'));
  assert.throws(() => resolveWorkspace('~/Development/private/secret', policy, { home }), /not allowed/);
  assert.throws(() => resolveWorkspace('project', policy, { home, base: home }), /ENOENT/);
  writeFileSync(path.join(home, 'Development/file'), 'text');
  assert.throws(() => resolveWorkspace('~/Development/file', policy, { home }), /directory/);
  assert.throws(() => resolveWorkspace(project, { allow: [], exclude: [] }, { home }), /not allowed/);
});

test('single-component * is distinct from recursive **', t => {
  const { home, make } = fixture(t);
  const project = make('Development/project');
  const nested = make('Development/project/nested');
  const policy = { allow: ['~/Development/*'], exclude: [] };
  assert.equal(resolveWorkspace(project, policy, { home }), project);
  assert.throws(() => resolveWorkspace(nested, policy, { home }), /not allowed/);
  assert.throws(() => resolveWorkspace(path.dirname(project), policy, { home }), /not allowed/);
  const suffixPolicy = { allow: ['~/Development/**/nested'], exclude: [] };
  assert.equal(resolveWorkspace(nested, suffixPolicy, { home }), nested);
  const direct = make('Development/nested');
  assert.equal(resolveWorkspace(direct, suffixPolicy, { home }), direct);
});

test('canonical targets reject symlink, sibling-prefix, and traversal escapes', t => {
  const { home, make, policy } = fixture(t);
  const root = make('Development');
  const outside = make('Development-evil/project');
  symlinkSync(outside, path.join(root, 'escape'));
  assert.throws(() => resolveWorkspace(path.join(root, 'escape'), policy, { home }), /not allowed/);
  assert.throws(() => resolveWorkspace(outside, policy, { home }), /not allowed/);
  assert.throws(() => resolveWorkspace('../Development-evil/project', policy, { home, base: root }), /not allowed/);
  const privateDir = make('Development/private/hidden');
  symlinkSync(privateDir, path.join(root, 'innocent'));
  assert.throws(() => resolveWorkspace(path.join(root, 'innocent'), policy, { home }), /not allowed/);
  const project = make('Development/good');
  symlinkSync(project, path.join(home, 'alias'));
  assert.equal(resolveWorkspace(path.join(home, 'alias'), policy, { home }), project);
  symlinkSync(root, path.join(home, 'policy-alias'));
  assert.equal(resolveWorkspace(project, { allow: ['~/policy-alias/**'], exclude: [] }, { home }), project);
});

test('paths with shell metacharacters are literal; malformed policies fail closed', t => {
  const { home, make, policy } = fixture(t);
  const directory = make('Development/$(touch PWNED); quotes " spaced');
  assert.equal(resolveWorkspace(directory, policy, { home }), directory);
  for (const allow of [['relative/**'], ['~other/**'], ['~/Development/?'], [null]]) {
    assert.throws(() => resolveWorkspace(directory, { allow, exclude: [] }, { home }));
  }
  assert.throws(() => resolveWorkspace('bad\0path', policy, { home }));
});

test('bounded discovery shows sibling projects before filling the list with one project tree', t => {
  const { home, make, policy } = fixture(t);
  const root = make('Development');
  const first = make('Development/a-project');
  make('Development/a-project/deep/one/two/three');
  const second = make('Development/z-project');
  const dot = make('.nixos');
  assert.deepEqual(listWorkspaces(policy, { home, limit: 4 }), {
    workspaces: [dot, root, first, second].sort(), truncated: true,
  });
});

test('listing includes explicit dot directory, bounds results, and skips unsafe crawls', t => {
  const { home, make, policy } = fixture(t);
  const root = make('Development');
  const project = make('Development/project');
  const dot = make('.nixos');
  make('Development/private/secret');
  for (const skipped of ['.git', 'node_modules', '.direnv', '.cache']) make(`Development/${skipped}/deep`);
  const outside = make('outside/secret');
  symlinkSync(outside, path.join(root, 'escape'));
  symlinkSync(root, path.join(root, 'cycle'));
  assert.deepEqual(listWorkspaces(policy, { home }), { workspaces: [dot, root, project].sort(), truncated: false });
  const limited = listWorkspaces(policy, { home, limit: 1 });
  assert.equal(limited.workspaces.length, 1);
  assert.equal(limited.truncated, true);
  assert.deepEqual(listWorkspaces({ allow: ['~/missing/**'], exclude: [] }, { home }), { workspaces: [], truncated: false });
  assert.deepEqual(listWorkspaces({ allow: [], exclude: [] }, { home }), { workspaces: [], truncated: false });
  assert.throws(() => listWorkspaces(policy, { home, limit: 0 }));
});
