import test from 'node:test';
import assert from 'node:assert/strict';
import { createPajClient } from '../src/paj.ts';

const a = '11111111-1111-4111-8111-111111111111';
const b = '22222222-2222-4222-8222-222222222222';
const c = '33333333-3333-4333-8333-333333333333';
const session = (id, name, extra = {}) => ({ id, name, piSessionId: `pi-${id}`,
  role: 'primary', parentPiSessionId: null, projectId: id, projectRoot: `/projects/${name}`,
  status: 'idle', ...extra });
const message = (extra = {}) => ({ id: c, from: { id: b, name: 'worker' }, to: a,
  text: 'report', kind: 'update', taskId: 'assignment', createdAtMs: 1, ...extra });
const runner = (value, calls = []) => async (command, args, options) => {
  calls.push({ command, args, options });
  return { stdout: JSON.stringify(typeof value === 'function' ? value(args) : value) };
};

test('all-project main-only exact resolution rejects ambiguity, prefixes, child and self', async () => {
  const calls = [];
  const values = [session(a, 'captain'), session(b, 'worker'),
    session(c, 'child', { role: 'subagent', parentPiSessionId: 'parent' })];
  const client = createPajClient({ run: runner(values, calls) });
  assert.deepEqual((await client.listMain(`pi-${a}`)).map(value => value.id), [b]);
  assert.equal((await client.self(`pi-${a}`)).id, a);
  for (const reference of [b, `pi-${b}`, 'worker']) {
    assert.equal((await client.resolveMain(reference, `pi-${a}`)).id, b);
  }
  for (const reference of [a, b.slice(0, 10), 'child']) {
    await assert.rejects(client.resolveMain(reference, `pi-${a}`));
  }
  assert.ok(calls.every(call => call.command === 'paj'
    && JSON.stringify(call.args) === JSON.stringify(['--json', 'session', 'list', '--all'])
    && call.options.timeout > 0 && call.options.maxBuffer > 0));
  const ambiguous = createPajClient({ run: runner([session(a, 'same'), session(b, 'same')]) });
  await assert.rejects(ambiguous.resolveMain('same'));
  await assert.rejects(client.self('missing'));
});

test('invalid JSON, malformed records and CLI failure fail closed without retry', async () => {
  for (const run of [async () => ({ stdout: '{' }), async () => ({ stdout: '{}', exitCode: 1 }),
    runner([{}]), runner({}), runner([session(a, 'a'), session(a, 'b')]),
    async () => { throw new Error('timeout'); }]) {
    await assert.rejects(createPajClient({ run }).listMain());
  }
  let calls = 0;
  const client = createPajClient({ run: async () => { calls++; throw new Error('timeout'); } });
  await assert.rejects(client.send({ from: a, recipient: b, text: 'do it', kind: 'request', taskId: 't' }));
  assert.equal(calls, 1);
});

test('send passes exact sender/recipient and validates echoed correlation', async () => {
  const sent = message({ from: { id: a, name: 'captain' }, to: b, text: 'hello',
    kind: 'answer', inReplyTo: a });
  const calls = [];
  const client = createPajClient({ run: runner(sent, calls) });
  assert.deepEqual(await client.send({ from: a, recipient: b, text: 'hello', kind: 'answer',
    taskId: 'assignment', inReplyTo: a }), sent);
  assert.deepEqual(calls[0].args, ['--json', 'message', 'send', b, '--from', a,
    '--text', 'hello', '--kind', 'answer', '--task-id', 'assignment', '--in-reply-to', a]);
  await assert.rejects(client.send({ from: a, recipient: b, text: 'wrong', kind: 'answer',
    taskId: 'assignment', inReplyTo: a }));
});

test('paged reads validate recipient, progression, output limit and CLI failures', async () => {
  const valid = { status: 'ok', messages: [message()], nextCursor: 'next', hasMore: true };
  const calls = [];
  assert.deepEqual(await createPajClient({ run: runner(valid, calls) }).readPage(a, 'before'), valid);
  assert.deepEqual(calls[0].args, ['--json', 'message', 'read', a, '--limit', '128', '--after', 'before']);
  assert.ok(calls[0].options.maxBuffer <= 1024 ** 2 + 1);
  const reset = { status: 'gap', reason: 'reset' };
  assert.deepEqual(await createPajClient({ run: runner(reset) }).readPage(a, 'before'), reset);
  for (const bad of [{ ...valid, messages: [message({ to: b })] }, { ...valid, messages: [message(), message()] },
    { ...valid, messages: [] }, { ...valid, nextCursor: 'before' }]) {
    await assert.rejects(createPajClient({ run: runner(bad) }).readPage(a, 'before'), /Invalid Paj message page/);
  }
  const unsupported = createPajClient({ run: async () => { throw Object.assign(new Error('clap'),
    { code: 2, stderr: "error: unrecognized subcommand 'read'\n" }); } });
  await assert.rejects(unsupported.readPage(a), /clap/);
  const broken = createPajClient({ run: async () => { throw Object.assign(new Error('locked'),
    { code: 2, stderr: 'lock unavailable\n' }); } });
  await assert.rejects(broken.readPage(a), /locked/);
});
