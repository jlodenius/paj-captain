import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { registerCaptain } from '../src/extension.ts';
import { captainPaths } from '../src/config.ts';

const Type = Object.fromEntries(['Object', 'String', 'Optional', 'Array', 'Boolean'].map(name => [name, () => ({})]));

function fixture(t, failAnswers = false) {
  const root = mkdtempSync(join(tmpdir(), 'captain-roundtrip-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const owner = { id: randomUUID(), name: 'Captain', piSessionId: randomUUID(),
    projectId: 'captain', projectRoot: root, role: 'primary', status: 'idle' };
  const worker = { ...owner, id: randomUUID(), name: 'Worker', piSessionId: randomUUID() };
  const incoming = [];
  const sent = [];
  const tools = new Map();
  const handlers = new Map();
  const commands = new Map();
  let selected = [];
  const pi = { registerTool: tool => tools.set(tool.name, tool), on: (name, handler) => handlers.set(name, handler),
    getActiveTools: () => selected, setActiveTools: names => { selected = names; },
    registerCommand: (name, command) => commands.set(name, command), appendEntry() {} };
  const ctx = { cwd: root, ui: { setStatus() {}, notify() {} }, waitForIdle: async () => {},
    sessionManager: { getSessionId: () => owner.piSessionId, getBranch: () => [] } };
  const client = { self: async () => owner, resolveMain: async () => worker,
    incoming: async () => incoming, listMain: async () => [worker], send: async args => {
      sent.push(args);
      if (failAnswers && args.kind === 'answer') throw new Error('Uncertain answer timeout');
      return { id: randomUUID(), from: { id: owner.id, name: owner.name }, to: worker.id,
        createdAtMs: Date.now(), kind: args.kind, text: args.text, taskId: args.taskId, inReplyTo: args.inReplyTo };
    } };
  registerCaptain(pi, Type, { paths: captainPaths({ PI_CODING_AGENT_DIR: root }), client });
  const tool = async (name, params, id = randomUUID()) =>
    (await tools.get(name).execute(id, params, undefined, undefined, ctx)).details;
  return { owner, worker, incoming, sent, tools, handlers, ctx, tool,
    enable: () => commands.get('captain').handler('', ctx),
    message: (task, kind, text) => ({ id: randomUUID(), from: { id: worker.id, name: worker.name },
      to: owner.id, createdAtMs: Date.now(), taskId: task.id, kind, text }) };
}

test('concurrent duplicate delegate calls send one request, including while the first send is pending', async t => {
  const f = fixture(t);
  await f.enable();
  const params = { recipient: f.worker.id, assignment: 'One finite assignment' };
  const [first, second] = await Promise.all([
    f.tool('captain_delegate', params, 'same-call'), f.tool('captain_delegate', params, 'same-call'),
  ]);
  assert.equal(first.id, second.id);
  assert.equal(f.sent.length, 1);
});

test('questions, duplicate answers and terminal results stay correlated through Captain tools', async t => {
  const f = fixture(t);
  await f.enable();
  const task = await f.tool('captain_delegate', { recipient: f.worker.id, assignment: 'Implement and report checks.' });
  const question = f.message(task, 'question', 'Which option?');
  f.incoming.push(question);
  assert.equal((await f.tool('captain_tasks', { taskId: task.id })).status, 'waiting_for_answer');
  const answer = { taskId: task.id, questionId: question.id, answer: 'Use option A.' };
  await Promise.all([f.tool('captain_reply', answer), f.tool('captain_reply', answer)]);
  assert.equal(f.sent.filter(message => message.kind === 'answer').length, 1);
  assert.equal(f.sent.at(-1).inReplyTo, question.id);
  assert.equal((await f.tool('captain_tasks', { taskId: task.id })).status, 'queued');
  const blocked = await f.handlers.get('tool_call')({ toolName: 'send_agent_message',
    input: { recipient: f.worker.id, kind: 'answer', inReplyTo: question.id } }, f.ctx);
  assert.equal(blocked.block, true);
  f.incoming.push(f.message(task, 'result', 'Done, tests passed.'));
  assert.equal((await f.tool('captain_tasks', { taskId: task.id })).status, 'completed');
  await assert.rejects(f.tool('captain_reply', answer), /completed/);
  assert.equal(f.sent.length, 2);
});

test('the incoming Paj batch updates the ledger even if history/pending race with acknowledgement', async t => {
  const f = fixture(t);
  await f.enable();
  const task = await f.tool('captain_delegate', { recipient: f.worker.id, assignment: 'Finite task' });
  const report = f.message(task, 'result', 'Completed with checks.');
  await f.handlers.get('before_agent_start')({ systemPrompt: 'Original', messageType: 'custom',
    message: { customType: 'paj-messages', details: { messages: [report] } } }, f.ctx);
  assert.equal(f.incoming.length, 0);
  assert.equal((await f.tool('captain_tasks', { taskId: task.id })).status, 'completed');
});

test('an uncertain answer is retained and not resent by a later tool call', async t => {
  const f = fixture(t, true);
  await f.enable();
  const task = await f.tool('captain_delegate', { recipient: f.worker.id, assignment: 'Finite task' });
  const question = f.message(task, 'question', 'Need a decision');
  f.incoming.push(question);
  const answer = { taskId: task.id, questionId: question.id, answer: 'Proceed.' };
  const unknown = await f.tool('captain_reply', answer);
  assert.equal(unknown.replies[0].status, 'delivery_unknown');
  await f.tool('captain_reply', answer);
  assert.equal(f.sent.filter(message => message.kind === 'answer').length, 1);
});
