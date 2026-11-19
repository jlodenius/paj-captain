import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, cpSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));

test('rebuilding drops generated modules removed from source', t => {
  const temporary = mkdtempSync(join(tmpdir(), 'captain-rebuild-'));
  t.after(() => rmSync(temporary, { recursive: true, force: true }));
  for (const name of ['src', 'extensions', 'scripts', 'package.json']) {
    cpSync(join(root, name), join(temporary, name), { recursive: true });
  }
  const build = () => {
    const result = spawnSync(process.execPath, ['scripts/build.ts'], {
      cwd: temporary, encoding: 'utf8', timeout: 10000,
    });
    assert.equal(result.status, 0, result.stderr);
  };
  const source = join(temporary, 'src/inspection.ts');
  const generated = join(temporary, 'dist/src/inspection.js');
  build();
  assert.ok(existsSync(generated));
  rmSync(source);
  build();
  assert.ok(!existsSync(generated));
  assert.ok(existsSync(join(temporary, 'dist/src/extension.js')));
});

test('built distribution executes below node_modules with a JavaScript launch helper', {
  skip: !existsSync(join(root, 'dist/src/launch.js')) && 'Run npm run build first',
}, t => {
  const temporary = mkdtempSync(join(tmpdir(), 'captain-distribution-'));
  t.after(() => rmSync(temporary, { recursive: true, force: true }));
  const installed = join(temporary, 'node_modules', 'paj-captain');
  mkdirSync(installed, { recursive: true });
  for (const name of ['dist', 'skills', 'package.json']) {
    cpSync(join(root, name), join(installed, name), { recursive: true });
  }
  const metadata = JSON.parse(readFileSync(join(installed, 'package.json'), 'utf8'));
  assert.deepEqual(metadata.pi.extensions, ['dist/extensions']);
  const script = `
    import assert from 'node:assert/strict';
    import { launchMain } from 'paj-captain/dist/src/launch.js';
    import { registerCaptain } from 'paj-captain/dist/src/extension.js';
    import { CAPTAIN_COMPACTION_GUIDANCE } from 'paj-captain/dist/src/compaction.js';
    assert.equal(typeof registerCaptain, 'function');
    assert.ok(CAPTAIN_COMPACTION_GUIDANCE.length > 0);
    await launchMain({workspace: process.cwd(), requestId: 'distribution'},
      {allow: [process.cwd()], exclude: []}, {
        env: {...process.env, PI_CODING_AGENT_DIR: process.cwd() + '/agent'},
        piExecutable: process.execPath,
        run: async (command, args) => {
          assert.equal(command, 'tmux');
          assert.ok(args.at(-2).endsWith('/dist/src/run-main.js'));
          const {spawnSync} = await import('node:child_process');
          const payload = JSON.parse(Buffer.from(args.at(-1), 'base64url').toString());
          payload.policy.allow = [];
          const child = spawnSync(process.execPath, [args.at(-2),
            Buffer.from(JSON.stringify(payload)).toString('base64url')], {encoding:'utf8'});
          assert.equal(child.status, 1);
          assert.match(child.stderr, /Workspace is not allowed/);
          assert.doesNotMatch(child.stderr, /type.stripping|ERR_UNSUPPORTED|ERR_MODULE_NOT_FOUND/i);
          return {stdout: args[args.indexOf('-s') + 1]};
        }
      });
  `;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: temporary, encoding: 'utf8', timeout: 10000,
  });
  assert.equal(result.status, 0, result.stderr);
});
