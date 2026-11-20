import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, mkdirSync, existsSync, writeFileSync, symlinkSync, rmSync, truncateSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createLedgerMaintenance, WARNING_BYTES } from '../src/ledger-maintenance.ts';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'captain-erase-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dir = join(root, 'sessions');
  mkdirSync(dir, { mode: 0o700 });
  const ledger = join(dir, 'one.json');
  const save = (file = ledger) => {
    writeFileSync(`${file}.lock`, '', { mode: 0o600 });
    writeFileSync(file, '{"version":1,"tasks":[]}', { mode: 0o600 });
  };
  return { root, dir, ledger, maintenance: createLedgerMaintenance(dir), save };
}

test('erase requires cutover, rechecks the preview, and removes only ledger data', t => {
  const f = fixture(t);
  f.save();
  const notes = join(f.dir, 'operator-notes.txt');
  const sibling = join(f.root, 'launch-receipt.json');
  const lock = `${f.ledger}.lock`;
  for (const path of [notes, sibling, lock]) writeFileSync(path, '', { mode: 0o600 });
  assert.throws(() => f.maintenance.preview(), /establish-ledger-cutover/);
  f.maintenance.establish();
  const preview = f.maintenance.preview();
  assert.deepEqual(preview.names, ['one.json']);
  f.save(join(f.dir, 'two.json'));
  assert.throws(() => f.maintenance.erase(preview.digest), /changed after preview/);
  assert.ok(existsSync(f.ledger));
  assert.equal(f.maintenance.erase(f.maintenance.preview().digest), 2);
  assert.equal(f.maintenance.preview().names.length, 0);
  for (const path of [notes, sibling, lock]) assert.ok(existsSync(path));
});

test('coordination spans processes and releases an abandoned activation lease', async t => {
  const f = fixture(t);
  f.save();
  f.maintenance.establish();
  const module = new URL('../src/ledger-maintenance.ts', import.meta.url).href;
  const script = `import { createLedgerMaintenance } from ${JSON.stringify(module)};
    createLedgerMaintenance(process.argv[1]).lease(); console.log('ready'); setInterval(() => {}, 1000);`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', script, f.dir], { stdio: ['ignore', 'pipe', 'inherit'] });
  t.after(() => { if (child.exitCode === null) child.kill('SIGKILL'); });
  assert.match(String((await once(child.stdout, 'data'))[0]), /ready/);
  const other = f.maintenance.lease();
  assert.throws(() => f.maintenance.preview(), /Turn Captain off/);
  other();
  assert.throws(() => f.maintenance.preview(), /Turn Captain off/);
  const exited = once(child, 'exit');
  child.kill('SIGKILL');
  await exited;
  const gate = join(f.dir, '.captain-ledger-gate');
  const exclusive = spawnSync('flock', ['-n', '-x', gate, process.execPath, '--input-type=module', '-e',
    `import { createLedgerMaintenance } from ${JSON.stringify(module)};
     try { createLedgerMaintenance(process.argv[1]).lease(); process.exit(9); }
     catch (e) { if (!String(e).includes('maintenance is running')) throw e; }`, f.dir]);
  assert.equal(exclusive.status, 0, String(exclusive.stderr));
  const legacy = spawnSync('flock', ['-n', '-x', `${f.ledger}.lock`, process.execPath, '--input-type=module', '-e',
    `import { createLedgerMaintenance } from ${JSON.stringify(module)};
     try { createLedgerMaintenance(process.argv[1]).preview(); process.exit(9); }
     catch (e) { if (!String(e).includes('older runtime')) throw e; }`, f.dir]);
  assert.equal(legacy.status, 0, String(legacy.stderr));
  assert.ok(existsSync(f.ledger));
  assert.equal(f.maintenance.erase(f.maintenance.preview().digest), 1);
});

test('unsafe paths, unknown files and incomplete legacy writes refuse before removing any ledger', t => {
  const f = fixture(t);
  f.save();
  f.maintenance.establish();
  const link = join(f.dir, 'link.json');
  symlinkSync(f.ledger, link);
  assert.throws(() => f.maintenance.preview());
  rmSync(link);
  const unrelated = join(f.dir, 'unrelated.json');
  writeFileSync(unrelated, '{"version":1,"tasks":[]}', { mode: 0o600 });
  assert.throws(() => f.maintenance.preview(), /Cannot verify/);
  assert.ok(existsSync(unrelated));
  rmSync(unrelated);
  const malformed = join(f.dir, 'bad.json');
  writeFileSync(malformed, '{"version":42}', { mode: 0o600 });
  assert.throws(() => f.maintenance.preview(), /Corrupt task ledger/);
  rmSync(malformed);
  writeFileSync(`${f.ledger}.12345678-1234-1234-1234-123456789012.tmp`, '', { mode: 0o600 });
  assert.throws(() => f.maintenance.preview(), /Unresolved ledger write/);
  assert.ok(existsSync(f.ledger));
});

test('an interrupted erase blocks activation and needs a newly confirmed preview', t => {
  const f = fixture(t);
  f.save();
  f.maintenance.establish();
  const before = f.maintenance.preview();
  const interrupted = join(f.dir, '.captain-ledger-erase-incomplete');
  writeFileSync(interrupted, 'captain-ledger-cutover-v1\n', { mode: 0o600 });
  rmSync(f.ledger);
  assert.throws(() => f.maintenance.lease(), /interrupted/);
  assert.throws(() => f.maintenance.erase(before.digest), /changed after preview/);
  const remaining = f.maintenance.preview();
  assert.equal(remaining.interrupted, true);
  assert.deepEqual(remaining.names, []);
  assert.equal(f.maintenance.erase(remaining.digest), 0);
  assert.ok(!existsSync(interrupted));
  f.maintenance.lease()();
});

test('3 GiB warning is metadata-only, strict at the threshold and skips unrelated and symlink entries', async t => {
  const f = fixture(t);
  f.save();
  truncateSync(f.ledger, WARNING_BYTES);
  symlinkSync(f.ledger, join(f.dir, 'link.json'));
  writeFileSync(join(f.dir, 'large.txt'), '');
  truncateSync(join(f.dir, 'large.txt'), WARNING_BYTES);
  assert.equal(await f.maintenance.large(), false);
  truncateSync(f.ledger, WARNING_BYTES + 1);
  assert.equal(await f.maintenance.large(), true);
  rmSync(f.dir, { recursive: true });
  assert.equal(await f.maintenance.large(), false);
});
