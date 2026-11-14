import test from 'node:test';
import assert from 'node:assert/strict';
import { createPajClient } from '../src/paj.js';

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

test('incoming reads history plus pending, deduplicates, never acknowledges', async () => {
  const calls = [];
  const client = createPajClient({ run: runner(args => args[2] === 'history'
    ? [message()] : [message(), message({ id: b, createdAtMs: 2 })], calls) });
  assert.deepEqual((await client.incoming(a)).map(value => value.id), [c, b]);
  assert.deepEqual(calls.map(call => call.args[2]).sort(), ['history', 'pending']);
  await assert.rejects(createPajClient({ run: runner([message({ to: b })]) }).incoming(a));
  await assert.rejects(createPajClient({ run: runner(args => [message({
    text: args[2] === 'history' ? 'one' : 'two' })]) }).incoming(a));
});
