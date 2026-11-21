import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { createPajClient } from '../src/paj.ts';
import { createTaskStore } from '../src/tasks.ts';
import { registerCaptain } from '../src/extension.ts';
import { captainPaths } from '../src/config.ts';

const execute = promisify(execFile);
const paging = process.env.PAJ_CAPTAIN_PAGED_INTEGRATION === '1';

test('real isolated Paj roundtrip preserves main-only delegation, questions, replies and results',
  { skip: !process.env.PAJ_CAPTAIN_PAJ_BIN || !paging, timeout: 30000 }, async t => {
  const root = mkdtempSync(join(tmpdir(), 'captain-paj-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const captainCwd = join(root, 'captain');
  const workerCwd = join(root, 'worker');
  mkdirSync(captainCwd);
  mkdirSync(workerCwd);
  const env = { ...process.env, PAJ_RUNTIME_DIR: join(root, 'registry') };
  const command = async (args, cwd = captainCwd) => {
    const { stdout } = await execute(process.env.PAJ_CAPTAIN_PAJ_BIN, ['--json', ...args], { env, cwd, timeout: 5000 });
    return stdout.trim() ? JSON.parse(stdout) : undefined;
  };
  const ownPiId = randomUUID();
  const workerPiId = randomUUID();
  const owner = await command(['session', 'register', '--pid', `${process.pid}`, '--pi-session-id', ownPiId,
    '--name', 'captain-test', '--role', 'primary']);
  const worker = await command(['session', 'register', '--pid', `${process.pid}`, '--pi-session-id', workerPiId,
    '--name', 'worker-test', '--role', 'primary'], workerCwd);
  await command(['session', 'register', '--pid', `${process.pid}`, '--pi-session-id', randomUUID(),
    '--name', 'child-test', '--role', 'subagent', '--parent-pi-session-id', workerPiId], workerCwd);
  const client = createPajClient({ cwd: captainCwd, env,
    run: (_command, args, options) => execute(process.env.PAJ_CAPTAIN_PAJ_BIN, args, options) });
  assert.equal((await client.self(ownPiId)).id, owner.id);
  assert.deepEqual((await client.listMain(ownPiId)).map(session => session.id), [worker.id]);
  await assert.rejects(client.resolveMain('child-test', ownPiId));
  const ledger = createTaskStore(join(root, 'state', 'tasks.json'));
  const assignment = '- Review this workspace.\n- Report findings and checks.';
  const task = ledger.begin({ requestId: 'assignment-one', ownerPiSessionId: ownPiId,
    ownerPajSessionId: owner.id, target: worker, assignment });
  const request = await client.send({ from: owner.id, recipient: worker.id, kind: 'request',
    taskId: task.id, text: task.assignment });
  assert.equal(ledger.markSent(task.id, request).status, 'queued');
  const workerInbox = await command(['message', 'pending', worker.id]);
  assert.equal(workerInbox.find(message => message.id === request.id)?.text, assignment);
  const obsolete = await client.send({ from: worker.id, recipient: owner.id, kind: 'question',
    taskId: task.id, inReplyTo: request.id, text: 'Should I include uncommitted changes?' });
  const question = await command(['message', 'send', owner.id, '--from', worker.id, '--kind', 'question',
    '--task-id', task.id, '--in-reply-to', request.id, '--supersedes', obsolete.id,
    '--text', 'Include both staged and unstaged changes?']);
  const handlers = new Map();
  const commands = new Map();
  const Type = Object.fromEntries(['Object', 'String', 'Optional', 'Array', 'Boolean'].map(name => [name, () => ({})]));
  const pi = {
    events: { emit: (_name, request) => request.reply(Promise.resolve()) },
    on: (name, handler) => handlers.set(name, handler), registerTool() {}, appendEntry() {},
    registerCommand: (name, command) => commands.set(name, command), getActiveTools: () => [], setActiveTools() {},
  };
  const ctx = { cwd: captainCwd, ui: { setStatus() {}, notify() {} }, waitForIdle: async () => {},
    sessionManager: { getSessionId: () => ownPiId } };
  registerCaptain(pi, Type, { client, paths: captainPaths({ PI_CODING_AGENT_DIR: root }),
    createTaskStore: () => ledger });
  await commands.get('captain').handler('', ctx);
  t.after(() => commands.get('captain').handler('off', ctx));
  const genericAnswer = inReplyTo => handlers.get('tool_call')({
    toolName: 'send_agent_message', input: { recipient: worker.name, kind: 'answer', inReplyTo },
  }, ctx);

  // Neither answer decision can rely on a saved question or a completed page refresh.
  for (const original of [obsolete, question]) {
    assert.match((await genericAnswer(original.id)).reason, /Use captain_reply/);
  }
  const untracked = await command(['message', 'send', owner.id, '--from', worker.id, '--kind', 'question',
    '--text', 'Can I ask an unrelated question?']);
  assert.equal(await genericAnswer(untracked.id), undefined);
  const genericReply = await command(['message', 'send', worker.name, '--from', owner.id, '--kind', 'answer',
    '--in-reply-to', untracked.id, '--text', 'Yes, go ahead.']);
  assert.equal(genericReply.inReplyTo, untracked.id);
  assert.equal(genericReply.taskId, undefined);
  await command(['message', 'ack', owner.id, untracked.id]);

  const observe = async () => {
    const expected = ledger.checkpoint(owner.id);
    const page = await client.readPage(owner.id, expected?.cursor);
    assert.equal(page.status, 'ok', JSON.stringify(page));
    assert.equal(page.hasMore, false);
    ledger.observe(page.messages, { expected, next: { registration: owner.id, cursor: page.nextCursor } });
  };
  await observe();
  assert.equal(ledger.get(task.id).status, 'waiting_for_answer');
  await command(['message', 'ack', owner.id, question.id]);
  assert.throws(() => ledger.prepareReply(task.id, { questionId: obsolete.id, text: 'Obsolete answer' }));
  assert.equal(ledger.prepareReply(task.id, { questionId: question.id, text: 'Yes, include them.' }).reused, false);
  const answer = await client.send({ from: owner.id, recipient: worker.id, kind: 'answer',
    taskId: task.id, inReplyTo: question.id, text: 'Yes, include them.' });
  assert.equal(ledger.recordReply(task.id, { questionId: question.id, message: answer }).status, 'queued');
  const report = await client.send({ from: worker.id, recipient: owner.id, kind: 'result',
    taskId: task.id, inReplyTo: request.id, text: 'Review complete. No findings. Tests passed.' });
  await observe();
  assert.equal(ledger.get(task.id).status, 'completed');
  assert.equal(ledger.get(task.id).result.id, report.id);
  const pending = await command(['message', 'pending', owner.id]);
  assert.deepEqual(pending.map(message => message.id).sort(), [report.id],
    'Captain observations must not steal Paj acknowledgements');
  assert.equal(createTaskStore(join(root, 'state', 'tasks.json')).get(task.id).result.text, report.text);
});
