import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { createTaskStore } from '../src/tasks.ts';

const owner = '11111111-1111-4111-8111-111111111111';
const worker = '22222222-2222-4222-8222-222222222222';
const target = { id: worker, name: 'worker', piSessionId: 'worker-pi', role: 'primary',
  parentPiSessionId: null, projectId: 'other-project', projectRoot: '/other', status: 'busy' };
const input = { requestId: 'tool-call-1', ownerPiSessionId: 'captain-pi', ownerPajSessionId: owner,
  target, assignment: 'Perform finite work and report.' };
const message = (task, extra = {}) => ({ id: randomUUID(), from: { id: worker, name: 'worker' },
  to: owner, text: 'progress', createdAtMs: 1, taskId: task.id, kind: 'update', ...extra });
const sent = task => message(task, { from: { id: owner, name: 'captain' }, to: worker,
  kind: 'request', text: task.assignment });
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'captain-tasks-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'sessions', 'captain-pi.json');
  return { dir, file, store: createTaskStore(file) };
}

test('intent precedes send, IDs persist, retries conflict and prepared restart is uncertain', t => {
  const { store, file } = fixture(t);
  const task = store.begin(input);
  assert.equal(task.status, 'prepared');
  assert.equal(JSON.parse(fs.readFileSync(file)).tasks[0].id, task.id);
  assert.deepEqual(store.begin(input), { ...task, reused: true });
  assert.deepEqual(store.begin({ ...input, target: { ...target, status: 'idle' } }), { ...task, reused: true });
  assert.throws(() => store.begin({ ...input, requestId: 'foreign', ownerPiSessionId: 'other-pi' }));
  assert.throws(() => store.begin({ ...input, assignment: 'different' }));
  const reopened = createTaskStore(file);
  assert.equal(reopened.get(task.id).status, 'delivery_unknown');
  assert.equal(reopened.begin(input).id, task.id);
  assert.equal(reopened.begin(input).status, 'delivery_unknown');
  assert.equal(reopened.markSent(task.id, sent(task)).status, 'queued');
  assert.equal(reopened.markUnknown(task.id, 'timeout').status, 'queued');
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.dirname(file)).mode & 0o777, 0o700);
  const copy = reopened.get(task.id);
  copy.assignment = 'mutated';
  assert.equal(reopened.get(task.id).assignment, input.assignment);
});

test('page observations and checkpoint commit together and stale readers cannot rewind', t => {
  const { store, file } = fixture(t);
  const task = store.begin(input);
  const first = { registration: owner, cursor: 'first' };
  const second = { registration: owner, cursor: 'second' };
  const question = message(task, { kind: 'question', text: 'Which document?' });
  store.observe([question], { next: first });
  const reopened = createTaskStore(file);
  assert.deepEqual(reopened.checkpoint(owner), first);
  assert.equal(reopened.get(task.id).questions[0].id, question.id);
  const report = message(task, { kind: 'result' });
  assert.throws(() => store.observe([report], { next: second }), /checkpoint changed/);
  assert.deepEqual(reopened.checkpoint(owner), first);
  assert.equal(reopened.get(task.id).result, null);
  store.observe([question, report], { expected: first, next: second });
  assert.deepEqual(reopened.checkpoint(owner), second);
  assert.equal(reopened.get(task.id).result.id, report.id);
  assert.equal(reopened.get(task.id).questions.length, 1);
});

test('indexed supersession survives bounded event eviction and a backward wall clock', t => {
  const { store } = fixture(t);
  const task = store.begin(input);
  const first = { registration: owner, cursor: 'old' };
  const original = message(task, { createdAtMs: 100 });
  store.observe([original, ...Array.from({ length: 64 }, () => message(task))], { next: first });
  assert.ok(!store.get(task.id).events.some(event => event.id === original.id));
  const replacement = message(task, { kind: 'question', supersedes: original.id, createdAtMs: 90 });
  store.observe([replacement], { expected: first, next: { registration: owner, cursor: 'current' } });
  assert.equal(store.get(task.id).questions[0].id, replacement.id);
  assert.equal(store.checkpoint(owner).cursor, 'current');
});

test('send uncertainty persists, session stores stay separate, no fabricated started state', t => {
  const { store, file } = fixture(t);
  const task = store.begin(input);
  assert.equal(store.markUnknown(task.id, new Error('timeout')).status, 'delivery_unknown');
  const reopened = createTaskStore(file);
  assert.equal(reopened.begin(input).status, 'delivery_unknown');
  const other = createTaskStore(path.join(path.dirname(file), 'second.json'));
  assert.deepEqual(other.list(), []);
  assert.throws(() => store.markSent(task.id, message(task)));
  assert.equal(store.get(task.id).status, 'delivery_unknown');
});

test('forged participants/task/scope are ignored, questions and accepted replies correlate', t => {
  const { store } = fixture(t);
  const task = store.begin(input);
  store.markSent(task.id, sent(task));
  for (const extra of [{ from: { id: owner, name: 'worker' } }, { to: worker },
    { taskId: 'forged' }, { senderTaskId: 'child-task' }, { recipientTaskId: 'child-task' }]) {
    assert.deepEqual(store.observe([message(task, { kind: 'result', ...extra })]), []);
  }
  assert.equal(store.get(task.id).status, 'queued');
  const q1 = message(task, { kind: 'question', text: 'Which option?' });
  const q2 = message(task, { kind: 'question', text: 'What scope?' });
  assert.equal(store.observe([q1, q2])[0].status, 'waiting_for_answer');
  assert.deepEqual(store.observe([q1]), []);
  assert.equal(store.get(task.id).questions.length, 2);
  assert.throws(() => store.prepareReply(task.id, { questionId: randomUUID(), text: 'yes' }));
  const prepared = store.prepareReply(task.id, { questionId: q1.id, text: 'Option A' });
  assert.equal(prepared.replies[0].status, 'prepared');
  assert.deepEqual(store.prepareReply(task.id, { questionId: q1.id, text: 'Option A' }).replies,
    prepared.replies);
  assert.throws(() => store.prepareReply(task.id, { questionId: q1.id, text: 'different' }));
  const answer = message(task, { from: { id: owner, name: 'captain' }, to: worker,
    kind: 'answer', inReplyTo: q1.id, text: 'Option A' });
  assert.throws(() => store.recordReply(task.id, { questionId: q2.id, message: answer }));
  assert.equal(store.recordReply(task.id, { questionId: q1.id, message: answer }).status,
    'waiting_for_answer');
  store.prepareReply(task.id, { questionId: q2.id, text: 'This project' });
  const second = { ...answer, id: randomUUID(), inReplyTo: q2.id, text: 'This project' };
  assert.equal(store.recordReply(task.id, { questionId: q2.id, message: second }).status, 'queued');
});

test('reply intents survive crash/timeout, duplicate accepted reply remains idempotent', t => {
  const { store, file } = fixture(t);
  const task = store.begin(input);
  const question = message(task, { kind: 'question' });
  store.observe([question]);
  store.prepareReply(task.id, { questionId: question.id, text: 'answer' });
  const reopened = createTaskStore(file);
  assert.equal(reopened.get(task.id).replies[0].status, 'delivery_unknown');
  const reply = { questionId: question.id, text: 'answer' };
  assert.equal(reopened.prepareReply(task.id, reply).replies[0].status, 'delivery_unknown');
  reopened.markReplyUnknown(task.id, { questionId: question.id, error: 'timeout' });
  const answer = message(task, { from: { id: owner, name: 'captain' }, to: worker,
    kind: 'answer', inReplyTo: question.id, text: 'answer' });
  reopened.recordReply(task.id, { questionId: question.id, message: answer });
  assert.equal(reopened.recordReply(task.id, { questionId: question.id, message: answer })
    .replies[0].messageId, answer.id);
  assert.throws(() => reopened.recordReply(task.id, { questionId: question.id,
    message: { ...answer, id: randomUUID() } }));
});

test('result alone closes task permanently, updates and late replies never reopen', t => {
  const { store } = fixture(t);
  const task = store.begin(input);
  const update = message(task);
  assert.equal(store.observe([update])[0].status, 'delivery_unknown');
  const question = message(task, { kind: 'question' });
  store.observe([question]);
  const result = message(task, { kind: 'result', text: 'Done with checks.' });
  assert.equal(store.observe([result])[0].status, 'completed');
  assert.deepEqual(store.observe([result, message(task), message(task, { kind: 'question' })]), []);
  assert.equal(store.markSent(task.id, sent(task)).status, 'completed');
  assert.equal(store.markUnknown(task.id, 'timeout').status, 'completed');
  assert.throws(() => store.prepareReply(task.id, { questionId: question.id, text: 'late' }));
  assert.equal(store.get(task.id).result.text, 'Done with checks.');
});

test('bounded tasks, assignments, questions, observations and reports fail safely', t => {
  const { store } = fixture(t);
  assert.throws(() => store.begin({ ...input, assignment: 'x'.repeat(16385) }));
  assert.deepEqual(store.list(), []);
  const task = store.begin(input);
  const big = message(task, { text: 'x'.repeat(20000) });
  assert.equal(store.observe([big])[0].events[0].text.length, 16384);
  const unicode = message(task, { text: '🙂'.repeat(5000) });
  assert.ok(Buffer.byteLength(store.observe([unicode])[0].events.at(-1).text) <= 16384);
  for (let i = 0; i < 64; i++) store.observe([message(task, { kind: 'question' })]);
  assert.equal(store.observe([message(task, { kind: 'question' })])[0].questionsTruncated, true);
  assert.equal(store.get(task.id).questions.length, 64);
  for (let i = 1; i < 128; i++) store.begin({ ...input, requestId: `request-${i}` });
  assert.throws(() => store.begin({ ...input, requestId: 'overflow' }));
  assert.equal(store.list().length, 128);
});

test('saturated progress stays bounded and replay cannot change state or block questions/results', t => {
  const { store, file } = fixture(t);
  const task = store.begin(input);
  store.markSent(task.id, sent(task));
  const other = store.begin({ ...input, requestId: 'other-task' });
  const batch = Array.from({ length: 512 }, () => message(task));
  assert.equal(store.observe(batch).length, 1);
  const saturated = store.get(task.id);
  assert.equal(saturated.seenMessageIds.length, 512);
  assert.equal(saturated.events.length, 64);
  assert.deepEqual(store.observe([...batch, message(task)]), []);
  assert.deepEqual(store.get(task.id), saturated);
  const question = message(task, { kind: 'question' });
  assert.equal(store.observe([question])[0].status, 'waiting_for_answer');
  assert.equal(store.get(task.id).seenMessageIds.length, 512);
  assert.deepEqual(store.observe([question]), []);
  const reopened = createTaskStore(file);
  assert.deepEqual(reopened.observe([...batch, question, message(task)]), []);
  assert.equal(reopened.get(task.id).status, 'waiting_for_answer');
  const done = message(task, { kind: 'result', text: 'Done despite progress saturation.' });
  const otherDone = message(other, { kind: 'result', text: 'Other assignment also completes.' });
  assert.equal(reopened.observe([message(task), done, otherDone]).length, 2);
  assert.equal(reopened.get(task.id).status, 'completed');
  assert.equal(reopened.get(other.id).status, 'completed');
  assert.equal(reopened.get(task.id).seenMessageIds.length, 512);
  assert.deepEqual(reopened.observe([...batch, question, done, otherDone]), []);
});

test('question supersession handles archive+pending order, stale replies, restart, and replay', t => {
  const { store, file } = fixture(t);
  const task = store.begin(input);
  store.markSent(task.id, sent(task));
  const original = message(task, { kind: 'question', text: 'Old question', createdAtMs: 1 });
  const replacement = message(task, { kind: 'question', text: 'Corrected question',
    createdAtMs: 2, supersedes: original.id });
  assert.equal(store.observe([replacement, original, replacement])[0].status, 'waiting_for_answer');
  assert.equal(store.get(task.id).questions.find(value => value.id === original.id).supersededBy,
    replacement.id);
  assert.throws(() => store.prepareReply(task.id, { questionId: original.id, text: 'stale' }), /superseded/);
  store.prepareReply(task.id, { questionId: replacement.id, text: 'current answer' });
  const answer = message(task, { from: { id: owner, name: 'captain' }, to: worker,
    kind: 'answer', inReplyTo: replacement.id, text: 'current answer' });
  assert.equal(store.recordReply(task.id, { questionId: replacement.id, message: answer }).status, 'queued');
  const reopened = createTaskStore(file);
  assert.deepEqual(reopened.observe([original, replacement]), []);
  assert.equal(reopened.get(task.id).status, 'queued');
  assert.throws(() => reopened.prepareReply(task.id, { questionId: original.id, text: 'stale' }), /superseded/);
});

test('real isolated Paj archives superseded questions; combined pending/history replay remains correct',
  { skip: !process.env.PAJ_CAPTAIN_PAJ_BIN }, t => {
  const { store, file, dir } = fixture(t);
  const env = { ...process.env, PAJ_RUNTIME_DIR: path.join(dir, 'isolated-registry') };
  const command = args => {
    const result = spawnSync(process.env.PAJ_CAPTAIN_PAJ_BIN, ['--json', ...args], {
      env, cwd: dir, encoding: 'utf8', timeout: 5000,
    });
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout);
  };
  const captainPi = randomUUID();
  const captain = command(['session', 'register', '--pid', `${process.pid}`, '--pi-session-id', captainPi,
    '--name', 'supersession-captain', '--role', 'primary']);
  const workerSession = command(['session', 'register', '--pid', `${process.pid}`, '--pi-session-id', randomUUID(),
    '--name', 'supersession-worker', '--role', 'primary']);
  const task = store.begin({ ...input, ownerPiSessionId: captainPi, ownerPajSessionId: captain.id,
    target: workerSession });
  const send = (from, to, text, kind, extra = []) => command(['message', 'send', to,
    '--from', from, '--text', text, '--kind', kind, '--task-id', task.id, ...extra]);
  const request = send(captain.id, workerSession.id, task.assignment, 'request');
  store.markSent(task.id, request);
  const original = send(workerSession.id, captain.id, 'Original question', 'question',
    ['--in-reply-to', request.id]);
  const replacement = send(workerSession.id, captain.id, 'Corrected question', 'question',
    ['--in-reply-to', request.id, '--supersedes', original.id]);
  const history = command(['message', 'history', captain.id]);
  const pending = command(['message', 'pending', captain.id]);
  assert.deepEqual(history.map(value => value.id), [original.id]);
  assert.deepEqual(pending.map(value => value.id), [replacement.id]);
  store.observe([...pending, ...history]);
  assert.equal(store.get(task.id).questions.find(value => value.id === original.id).supersededBy,
    replacement.id);
  assert.throws(() => store.prepareReply(task.id, { questionId: original.id, text: 'stale' }), /superseded/);
  store.prepareReply(task.id, { questionId: replacement.id, text: 'Answer to corrected question' });
  const answer = send(captain.id, workerSession.id, 'Answer to corrected question', 'answer',
    ['--in-reply-to', replacement.id]);
  assert.equal(store.recordReply(task.id, { questionId: replacement.id, message: answer }).status, 'queued');
  const reopened = createTaskStore(file);
  assert.deepEqual(reopened.observe([...history, ...pending]), []);
  assert.equal(reopened.get(task.id).status, 'queued');
  const result = send(workerSession.id, captain.id, 'Completed with corrected scope', 'result',
    ['--in-reply-to', request.id]);
  reopened.observe([...command(['message', 'pending', captain.id]), ...history]);
  assert.equal(reopened.get(task.id).result.id, result.id);
  assert.equal(reopened.get(task.id).status, 'completed');
});

test('supersession requires exact original task, participants, scope, and causal linkage', t => {
  const { store } = fixture(t);
  const task = store.begin(input);
  const other = store.begin({ ...input, requestId: 'different-assignment' });
  const question = message(task, { kind: 'question', createdAtMs: 5 });
  const foreignQuestion = message(other, { kind: 'question', createdAtMs: 1 });
  store.observe([question, foreignQuestion]);
  for (const extra of [
    { supersedes: foreignQuestion.id },
    { supersedes: randomUUID() },
    { supersedes: question.id, from: { id: owner, name: 'forged' } },
    { supersedes: question.id, to: worker },
    { supersedes: question.id, senderTaskId: 'child' },
    { supersedes: question.id, recipientTaskId: 'child' },
    { supersedes: question.id, createdAtMs: 4 },
    { supersedes: 'malformed' },
  ]) {
    assert.deepEqual(store.observe([message(task, { kind: 'question', createdAtMs: 6, ...extra })]), []);
  }
  assert.equal(store.get(task.id).questions.length, 1);
  assert.equal(store.get(task.id).questions[0].supersededBy, undefined);
  const self = message(task, { kind: 'question', createdAtMs: 6 });
  assert.deepEqual(store.observe([{ ...self, supersedes: self.id }]), []);
});

test('a cancelling update supersedes a prepared question even after progress saturation', t => {
  const { store } = fixture(t);
  const task = store.begin(input);
  store.markSent(task.id, sent(task));
  const question = message(task, { kind: 'question' });
  store.observe([question]);
  store.prepareReply(task.id, { questionId: question.id, text: 'prepared old answer' });
  store.observe(Array.from({ length: 511 }, () => message(task)));
  const cancellation = message(task, { supersedes: question.id, text: 'No answer needed now.' });
  assert.equal(store.observe([cancellation])[0].status, 'queued');
  const before = store.get(task.id);
  assert.equal(before.questions[0].supersededBy, cancellation.id);
  assert.deepEqual(store.observe([question, cancellation]), []);
  assert.deepEqual(store.get(task.id), before);
  assert.throws(() => store.recordReply(task.id, { questionId: question.id,
    message: message(task, { kind: 'answer', from: { id: owner, name: 'captain' }, to: worker,
      text: 'prepared old answer', inReplyTo: question.id }) }), /superseded/);
});

test('an overflowing corrected question still invalidates its retained predecessor', t => {
  const { store, file } = fixture(t);
  const task = store.begin(input);
  let previous;
  for (let index = 0; index < 65; index++) {
    const question = message(task, { kind: 'question', text: `Correction ${index}`,
      createdAtMs: index + 1, ...(previous ? { supersedes: previous.id } : {}) });
    store.observe([question]);
    if (index === 64) {
      const saved = store.get(task.id);
      assert.equal(saved.questionsTruncated, true);
      assert.equal(saved.questions.at(-1).supersededBy, question.id);
      assert.throws(() => store.prepareReply(task.id, { questionId: previous.id, text: 'Stale answer' }), /superseded/);
      assert.throws(() => createTaskStore(file).prepareReply(task.id,
        { questionId: previous.id, text: 'Still stale after reload' }), /superseded/);
    }
    previous = question;
  }
});

test('question capacity cannot poison result handling for its task or unrelated assignments', t => {
  const { store } = fixture(t);
  const task = store.begin(input);
  const other = store.begin({ ...input, requestId: 'unrelated' });
  store.observe(Array.from({ length: 64 }, () => message(task, { kind: 'question' })));
  const overflow = message(task, { kind: 'question' });
  const results = [message(task, { kind: 'result' }), message(other, { kind: 'result' })];
  assert.equal(store.observe([overflow, ...results]).length, 2);
  assert.equal(store.get(task.id).questionsTruncated, true);
  assert.equal(store.get(task.id).questions.length, 64);
  assert.equal(store.get(task.id).status, 'completed');
  assert.equal(store.get(other.id).status, 'completed');
});

test('flock holds the same open file description until close without replacing its inode', t => {
  const { store, file } = fixture(t);
  const lock = `${file}.lock`;
  const original = fs.statSync(lock);
  const descriptor = fs.openSync(lock, fs.constants.O_RDWR | fs.constants.O_NOFOLLOW);
  try {
    const acquired = spawnSync('flock', ['-n', '3'], { stdio: ['ignore', 'pipe', 'pipe', descriptor] });
    assert.equal(acquired.status, 0);
    assert.throws(() => store.begin(input), /Ledger lock unavailable/);
    assert.throws(() => createTaskStore(file), /Ledger lock unavailable/);
  } finally { fs.closeSync(descriptor); }
  assert.equal(store.begin(input).status, 'prepared');
  assert.equal(fs.statSync(lock).ino, original.ino);
  assert.equal(fs.statSync(lock).mode & 0o777, 0o600);
});

test('SIGKILL while holding a real transaction releases flock and preserves durable uncertainty', async t => {
  const { store, file, dir } = fixture(t);
  const task = store.begin(input);
  const marker = path.join(dir, 'transaction-held');
  const module = fileURLToPath(new URL('../src/tasks.ts', import.meta.url));
  const script = `import fs from 'node:fs';import {createTaskStore} from ${JSON.stringify(module)};`
    + `const store=createTaskStore(${JSON.stringify(file)},{now(){`
    + `fs.writeFileSync(${JSON.stringify(marker)},'held');`
    + `Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0);return 1;}});`
    + `store.markUnknown(${JSON.stringify(task.id)},'interrupted');`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', script], { stdio: 'ignore' });
  const exited = once(child, 'exit');
  let exit;
  try {
    for (let i = 0; i < 200 && !fs.existsSync(marker) && child.exitCode === null; i++) {
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.equal(fs.existsSync(marker), true, 'child holds the ledger transaction');
    assert.throws(() => store.begin({ ...input, requestId: 'blocked' }), /Ledger lock unavailable/);
    child.kill('SIGKILL');
    exit = await exited;
  } finally {
    child.kill('SIGKILL');
    await exited;
  }
  assert.equal(exit[1], 'SIGKILL');
  const recovered = createTaskStore(file);
  assert.equal(recovered.get(task.id).status, 'delivery_unknown');
  assert.equal(recovered.begin(input).reused, true);
  assert.equal(recovered.get(task.id).requestMessageId, null);
  assert.equal(fs.existsSync(`${file}.lock`), true);
});

test('corruption, permissive files, and unsafe ledger/lock links fail closed', t => {
  const { store, file, dir } = fixture(t);
  store.begin(input);
  const original = fs.readFileSync(file);
  fs.writeFileSync(file, '{');
  assert.throws(() => createTaskStore(file));
  fs.writeFileSync(file, JSON.stringify({ version: 1, tasks: [{}] }));
  assert.throws(() => store.list());
  fs.writeFileSync(file, original);
  fs.chmodSync(file, 0o644);
  assert.throws(() => store.list());
  fs.chmodSync(file, 0o600);
  const link = path.join(dir, 'link');
  fs.symlinkSync(path.dirname(file), link);
  assert.throws(() => createTaskStore(path.join(link, 'unsafe.json')));
  const linked = path.join(path.dirname(file), 'linked.json');
  fs.symlinkSync(file, linked);
  assert.throws(() => createTaskStore(linked));
  fs.chmodSync(`${file}.lock`, 0o644);
  assert.throws(() => store.begin({ ...input, requestId: 'unsafe-lock' }), /Unsafe ledger lock/);
  fs.chmodSync(`${file}.lock`, 0o600);
  const lockLinkFile = path.join(path.dirname(file), 'lock-linked.json');
  fs.symlinkSync(`${file}.lock`, `${lockLinkFile}.lock`);
  assert.throws(() => createTaskStore(lockLinkFile));
  const hardlinkFile = path.join(path.dirname(file), 'hardlinked-lock.json');
  fs.linkSync(`${file}.lock`, `${hardlinkFile}.lock`);
  assert.throws(() => createTaskStore(hardlinkFile), /Unsafe ledger lock/);
  fs.unlinkSync(`${hardlinkFile}.lock`);
  assert.equal(store.list().length, 1);
  assert.deepEqual(fs.readdirSync(path.dirname(file)).filter(name => name.endsWith('.tmp')), []);
  fs.unlinkSync(file);
  assert.throws(() => store.list());
  assert.throws(() => store.begin({ ...input, requestId: 'missing-state' }));
});
