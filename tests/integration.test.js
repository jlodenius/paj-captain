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

const execute = promisify(execFile);

test('real isolated Paj roundtrip preserves main-only delegation, questions, replies and results',
  { skip: !process.env.PAJ_CAPTAIN_PAJ_BIN, timeout: 30000 }, async t => {
  const root = mkdtempSync(join(tmpdir(), 'captain-paj-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const captainCwd = join(root, 'captain');
  const workerCwd = join(root, 'worker');
  mkdirSync(captainCwd);
  mkdirSync(workerCwd);
  const env = { ...process.env, PAJ_RUNTIME_DIR: join(root, 'registry') };
  const command = async (args, cwd = captainCwd) => JSON.parse((await execute(process.env.PAJ_CAPTAIN_PAJ_BIN,
    ['--json', ...args], { env, cwd, timeout: 5000 })).stdout);
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
  const task = ledger.begin({ requestId: 'assignment-one', ownerPiSessionId: ownPiId,
    ownerPajSessionId: owner.id, target: worker, assignment: 'Review this workspace. Report findings and checks.' });
  const request = await client.send({ from: owner.id, recipient: worker.id, kind: 'request',
    taskId: task.id, text: task.assignment });
  assert.equal(ledger.markSent(task.id, request).status, 'queued');
  const obsolete = await client.send({ from: worker.id, recipient: owner.id, kind: 'question',
    taskId: task.id, inReplyTo: request.id, text: 'Should I include uncommitted changes?' });
  const question = await command(['message', 'send', owner.id, '--from', worker.id, '--kind', 'question',
    '--task-id', task.id, '--in-reply-to', request.id, '--supersedes', obsolete.id,
    '--text', 'Include both staged and unstaged changes?']);
  ledger.observe(await client.incoming(owner.id));
  assert.equal(ledger.get(task.id).status, 'waiting_for_answer');
  assert.throws(() => ledger.prepareReply(task.id, { questionId: obsolete.id, text: 'Obsolete answer' }));
  assert.equal(ledger.prepareReply(task.id, { questionId: question.id, text: 'Yes, include them.' }).reused, false);
  const answer = await client.send({ from: owner.id, recipient: worker.id, kind: 'answer',
    taskId: task.id, inReplyTo: question.id, text: 'Yes, include them.' });
  assert.equal(ledger.recordReply(task.id, { questionId: question.id, message: answer }).status, 'queued');
  const report = await client.send({ from: worker.id, recipient: owner.id, kind: 'result',
    taskId: task.id, inReplyTo: request.id, text: 'Review complete. No findings. Tests passed.' });
  ledger.observe(await client.incoming(owner.id));
  assert.equal(ledger.get(task.id).status, 'completed');
  assert.equal(ledger.get(task.id).result.id, report.id);
  const pending = await command(['message', 'pending', owner.id]);
  assert.deepEqual(pending.map(message => message.id).sort(), [question.id, report.id].sort(),
    'Captain observations must not steal Paj acknowledgements');
  assert.equal(createTaskStore(join(root, 'state', 'tasks.json')).get(task.id).result.text, report.text);
});
