import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, symlinkSync, rmSync,
  existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTaskStore } from '../src/tasks.ts';

const execute = promisify(execFile);

const rootPackage = fileURLToPath(new URL('../', import.meta.url));
const pajExtension = process.env.PAJ_CAPTAIN_PAJ_EXTENSION;
const guidance = readFileSync(new URL('../src/compaction-guidance.md', import.meta.url), 'utf8').trim();
const realPi = { skip: !process.env.PAJ_CAPTAIN_PI_BIN || !process.env.PAJ_CAPTAIN_PAJ_BIN || !pajExtension,
  timeout: 60000 };
const zeroCost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };

function seed(file, cwd, split, automatic) {
  let parentId = null;
  const entries = [{ type: 'session', version: 3, id: randomUUID(),
    timestamp: new Date().toISOString(), cwd }];
  const append = value => {
    const entry = { id: randomUUID().slice(0, 8), parentId,
      timestamp: new Date().toISOString(), ...value };
    entries.push(entry);
    parentId = entry.id;
  };
  const message = value => append({ type: 'message', message: { timestamp: Date.now(), ...value } });
  const assistant = content => message({ role: 'assistant', content, api: 'openai-completions',
    provider: 'captain-local-test', model: 'fixture', stopReason: 'stop',
    usage: { input: automatic ? 3500 : 500, output: 10, cacheRead: 0, cacheWrite: 0,
      totalTokens: automatic ? 3510 : 510, cost: zeroCost } });
  append({ type: 'model_change', provider: 'captain-local-test', modelId: 'fixture' });
  message({ role: 'user', content: 'Review guidance before implementation. Do not push. '.repeat(80) });
  assistant([{ type: 'toolCall', id: 'historical-read', name: 'read', arguments: { path: 'review.md' } },
    { type: 'toolCall', id: 'historical-write', name: 'write',
      arguments: { path: 'draft.md', content: 'historical content only' } }]);
  message({ role: 'toolResult', toolCallId: 'historical-read', toolName: 'read',
    content: [{ type: 'text', text: 'Historical read result' }], isError: false });
  message({ role: 'toolResult', toolCallId: 'historical-write', toolName: 'write',
    content: [{ type: 'text', text: 'Historical write result' }], isError: false });
  assistant([{ type: 'text', text: 'Review finished with caveats. '.repeat(70) }]);
  message({ role: 'user', content: 'Current unresolved task. '.repeat(80) });
  if (split) assistant([{ type: 'text', text: 'Earlier part of the current span. '.repeat(80) }]);
  assistant([{ type: 'text', text: 'Recent work retained verbatim. '.repeat(split ? 100 : 2) }]);
  writeFileSync(file, `${entries.map(entry => JSON.stringify(entry)).join('\n')}\n`);
}

async function fixture(t, { split = false, automatic = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'cpc-'));
  const agent = join(root, 'agent');
  const extensions = join(agent, 'extensions');
  mkdirSync(extensions, { recursive: true });
  mkdirSync(join(root, 'runtime'), { mode: 0o700 });
  mkdirSync(join(root, 'bin'));
  symlinkSync(process.env.PAJ_CAPTAIN_PAJ_BIN, join(root, 'bin', 'paj'));
  symlinkSync(rootPackage, join(extensions, 'paj-captain'));
  symlinkSync(pajExtension, join(extensions, 'paj'));
  writeFileSync(join(extensions, '00-observe.ts'), `export default function(pi) {
    pi.on('session_before_compact', (event, ctx) => {
      const p = event.preparation;
      ctx.ui.notify(JSON.stringify({testPreparation: true, reason:event.reason,
        firstKeptEntryId:p.firstKeptEntryId, tokensBefore:p.tokensBefore,
        isSplitTurn:p.isSplitTurn, history:p.messagesToSummarize.length,
        prefix:p.turnPrefixMessages.length, previousSummary:p.previousSummary}), 'info');
    });
    pi.registerCommand('compaction-test-reload', {description:'Reload fixture',
      handler:async (_args,ctx) => { await ctx.reload(); }});
  }`);
  writeFileSync(join(agent, 'settings.json'), JSON.stringify({ defaultProjectTrust: 'always',
    cacheWarming: 'off', enableInstallTelemetry: false, retry: { enabled: false },
    compaction: { enabled: automatic, reserveTokens: 1024, keepRecentTokens: split ? 100 : 300 } }));
  const requests = [];
  let failure = false;
  let heldSummary;
  const server = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    const payload = JSON.parse(body);
    const summary = JSON.stringify(payload.messages[0]).includes('context summarization assistant');
    const record = { payload, summary, headers: req.headers, text: `## Goal\nLocal summary ${requests.length + 1}\n`,
      failure: failure && summary };
    requests.push(record);
    if (summary && heldSummary) {
      heldSummary();
      return;
    }
    if (record.failure) {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'Deliberate fixture failure', type: 'invalid_request_error' } }));
      return;
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const chunk = value => res.write(`data: ${JSON.stringify({ id: 'local-response',
      object: 'chat.completion.chunk', created: 1, model: 'fixture', ...value })}\n\n`);
    chunk({ choices: [{ index: 0, delta: { role: 'assistant', content: record.text }, finish_reason: null }] });
    chunk({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      usage: { prompt_tokens: 123, completion_tokens: 17, total_tokens: 140 } });
    res.end('data: [DONE]\n\n');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  writeFileSync(join(agent, 'models.json'), JSON.stringify({ providers: { 'captain-local-test': {
    api: 'openai-completions', apiKey: 'local-fixture-only',
    headers: { 'X-Captain-Fixture': 'configured-registry' },
    baseUrl: `http://127.0.0.1:${server.address().port}/v1`, models: [{ id: 'fixture', name: 'Fixture',
      reasoning: false, input: ['text'], contextWindow: automatic ? 4096 : 1000000, maxTokens: 2048,
      cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 } }],
  } } }));
  const file = join(root, 'session.jsonl');
  seed(file, root, split, automatic);
  const env = Object.fromEntries(Object.entries(process.env)
    .filter(([key]) => !/API_KEY|TOKEN|SECRET|CREDENTIAL|^PAJ_|^CAPTAIN_|^PI_/.test(key)));
  Object.assign(env, { HOME: root, PI_CODING_AGENT_DIR: agent, XDG_RUNTIME_DIR: join(root, 'runtime'),
    PAJ_RUNTIME_DIR: join(root, 'p'), XDG_CONFIG_HOME: join(root, 'config'),
    PATH: `${join(root, 'bin')}:${process.env.PATH}` });
  const child = spawn(process.env.PAJ_CAPTAIN_PI_BIN, ['--offline', '--mode', 'rpc', '--session', file,
    '--provider', 'captain-local-test', '--model', 'fixture', '--thinking', 'off'],
  { cwd: root, env, stdio: ['pipe', 'pipe', 'pipe'] });
  let buffer = '';
  let errors = '';
  let next = 0;
  const events = [];
  const pending = new Map();
  const waiters = new Set();
  child.stderr.on('data', chunk => { errors += chunk; });
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', chunk => {
    buffer += chunk;
    let index;
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      if (!line.startsWith('{')) continue;
      const event = JSON.parse(line);
      events.push(event);
      if (event.type === 'response') {
        pending.get(event.id)?.resolve(event);
        pending.delete(event.id);
      }
      for (const waiter of waiters) if (waiter.predicate(event)) {
        waiter.resolve(event);
        waiters.delete(waiter);
      }
    }
  });
  child.on('exit', () => {
    for (const request of pending.values()) request.reject(new Error(`Pi exited: ${errors}`));
    pending.clear();
  });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = new Promise(resolve => child.once('exit', resolve));
      child.stdin.end();
      const timer = setTimeout(() => child.kill('SIGKILL'), 3000);
      await exited;
      clearTimeout(timer);
    }
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    rmSync(root, { recursive: true, force: true });
    for (const request of requests) {
      assert.equal(request.headers.authorization, 'Bearer local-fixture-only');
      assert.equal(request.headers['x-captain-fixture'], 'configured-registry');
    }
  });
  async function request(type, extra = {}, success = true) {
    const id = `request-${++next}`;
    const response = new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
    child.stdin.write(`${JSON.stringify({ id, type, ...extra })}\n`);
    const result = await response;
    assert.equal(result.success, success, result.error || errors);
    return result.data;
  }
  async function command(message) {
    const start = events.length;
    assert.equal((await request('prompt', { message })).disposition, 'handled');
    return events.slice(start).filter(event => event.method === 'notify');
  }
  async function prompt(message) {
    const settled = new Promise(resolve => waiters.add({
      predicate: event => event.type === 'agent_settled', resolve,
    }));
    await request('prompt', { message });
    await settled;
  }
  const entries = () => readFileSync(file, 'utf8').trim().split('\n').map(line => JSON.parse(line));
  const preparations = () => events.filter(event => event.method === 'notify')
    .flatMap(event => {
      try { const value = JSON.parse(event.message); return value.testPreparation ? [value] : []; }
      catch { return []; }
    });
  const ledgerFiles = () => {
    const dir = join(agent, 'captain', 'sessions');
    return existsSync(dir) ? readdirSync(dir).filter(name => name.endsWith('.json'))
      .map(name => [name, readFileSync(join(dir, name), 'utf8')]) : [];
  };
  async function enable() {
    const notices = await command('/captain');
    assert.ok(notices.some(event => event.message.startsWith('Captain enabled')), JSON.stringify({ notices, errors, events }));
  }
  async function seedUncertainTask() {
    const state = await request('get_state');
    const sessions = JSON.parse((await execute(process.env.PAJ_CAPTAIN_PAJ_BIN,
      ['--json', 'session', 'list', '--all'], { cwd: root, env })).stdout);
    const owner = sessions.find(value => value.piSessionId === state.sessionId);
    assert.ok(owner);
    const store = createTaskStore(join(agent, 'captain', 'sessions', `${state.sessionId}.json`));
    const worker = randomUUID();
    const task = store.begin({ requestId: 'historical-uncertain-send',
      ownerPiSessionId: state.sessionId, ownerPajSessionId: owner.id,
      target: { id: worker, name: 'historical-worker', piSessionId: randomUUID(), role: 'primary',
        parentPiSessionId: null, projectId: 'historical-project', projectRoot: root, status: 'idle' },
      assignment: 'Historical request with an uncertain outcome. Never resend automatically.' });
    store.markUnknown(task.id, 'Historical timeout');
    const question = { id: randomUUID(), from: { id: worker, name: 'historical-worker' },
      to: owner.id, taskId: task.id, kind: 'question', text: 'May I implement now?', createdAtMs: 1 };
    store.observe([question]);
    store.prepareReply(task.id, { questionId: question.id, text: 'Review must finish first.' });
    store.markReplyUnknown(task.id, { questionId: question.id, error: 'Historical reply timeout' });
    const snapshot = ledgerFiles();
    assert.equal(snapshot.length, 1);
    return snapshot;
  }
  return { request, command, prompt, requests, entries, preparations, enable, ledgerFiles, events,
    seedUncertainTask, fail: value => { failure = value; }, root, agent,
    holdSummary: () => new Promise(resolve => { heldSummary = resolve; }) };
}

function userText(request) {
  const content = request.payload.messages.at(-1).content;
  return typeof content === 'string' ? content
    : content.filter(block => block.type === 'text').map(block => block.text).join('\n');
}

function assertGuided(requests, focus) {
  assert.ok(requests.length > 0);
  for (const request of requests) {
    const last = request.payload.messages.at(-1);
    assert.equal(last.role, 'user');
    const text = userText(request);
    assert.ok(text.includes(guidance), 'Every summary request must receive the complete static focus');
    if (focus) assert.ok(text.includes(focus), 'Manual focus must also reach split-prefix requests');
    assert.ok(!request.payload.tools?.length, 'Summarization must not execute coordinator tools');
  }
}

function assertPersisted(f, result, callCount = 1) {
  const entry = f.entries().filter(value => value.type === 'compaction').at(-1);
  const preparation = f.preparations().at(-1);
  assert.equal(entry.firstKeptEntryId, preparation.firstKeptEntryId);
  assert.equal(entry.tokensBefore, preparation.tokensBefore);
  assert.equal(result.firstKeptEntryId, entry.firstKeptEntryId);
  assert.equal(entry.fromHook, true);
  assert.equal(entry.details.pajCaptainCompaction, 1);
  assert.deepEqual(entry.details.readFiles, ['review.md']);
  assert.deepEqual(entry.details.modifiedFiles, ['draft.md']);
  assert.equal(entry.usage.input, 123 * callCount);
  assert.equal(entry.usage.output, 17 * callCount);
  assert.equal(entry.usage.totalTokens, 140 * callCount);
  assert.ok(entry.usage.cost.total > 0);
  assert.deepEqual(result.usage, entry.usage);
  assert.ok(entry.summary.includes('Local summary'));
  return entry;
}

test('real Pi ordinary sessions keep stock compaction without Captain activation',
  realPi, async t => {
    const f = await fixture(t);
    await f.request('compact', { customInstructions: 'ORDINARY-FOCUS' });
    const entry = f.entries().find(value => value.type === 'compaction');
    assert.ok(entry);
    assert.ok(!entry.fromHook);
    assert.equal(entry.details?.pajCaptainCompaction, undefined);
    assert.deepEqual(entry.details.readFiles, ['review.md']);
    assert.deepEqual(entry.details.modifiedFiles, ['draft.md']);
    assert.equal(entry.firstKeptEntryId, f.preparations()[0].firstKeptEntryId);
    assert.equal(entry.tokensBefore, f.preparations()[0].tokensBefore);
    assert.equal(f.requests.length, 1);
    assert.ok(userText(f.requests[0]).includes('ORDINARY-FOCUS'));
    assert.ok(!userText(f.requests[0]).includes(guidance));
    assert.deepEqual(f.ledgerFiles(), []);
  });

test('real Pi persists guided manual and repeated compactions, requires activation after reload, and leaves off stock',
  realPi, async t => {
    const f = await fixture(t);
    await f.enable();
    const ledger = await f.seedUncertainTask();
    const focus = 'MANUAL-FOCUS: retain the pending authorization gate';
    const first = await f.request('compact', { customInstructions: focus });
    const firstEntry = assertPersisted(f, first);
    assert.equal(f.preparations()[0].isSplitTurn, false);
    assert.equal(f.requests.length, 1, 'No post-summary rewrite call');
    assertGuided(f.requests, focus);
    await f.command('/compaction-test-reload');
    await f.enable();
    await f.prompt('Continue the discussion only. '.repeat(160));
    const resumedSystem = JSON.stringify(f.requests.at(-1).payload.messages
      .filter(message => ['system', 'developer'].includes(message.role)));
    assert.match(resumedSystem, /Read the complete .*skills\/paj-captain\/SKILL\.md/);
    assert.match(resumedSystem, /After compaction, read it again even if you read it earlier in the session/);
    const start = f.requests.length;
    const second = await f.request('compact');
    assertPersisted(f, second);
    const summaryRequests = f.requests.slice(start);
    assert.equal(summaryRequests.length, 1);
    assertGuided(summaryRequests);
    assert.ok(userText(summaryRequests[0]).includes(firstEntry.summary),
      'Repeated compaction must include the previous summary');
    assert.deepEqual(f.ledgerFiles(), ledger, 'Compaction must not rewrite durable assignments');
    assert.ok(!existsSync(join(f.agent, 'captain', 'launches')), 'No launches while compacting');
    assert.ok(!f.events.some(event => event.type === 'tool_execution_start'), 'No history tool replay');
    assert.ok(!existsSync(join(f.root, 'draft.md')), 'Historical write was not executed');
    await f.command('/captain off');
    await f.prompt('Continue without Captain. '.repeat(160));
    assert.doesNotMatch(JSON.stringify(f.requests.at(-1).payload.messages
      .filter(message => ['system', 'developer'].includes(message.role))), /After compaction, read it again/);
    const offStart = f.requests.length;
    await f.request('compact', { customInstructions: 'OFF-MANUAL-FOCUS' });
    const stock = f.entries().filter(value => value.type === 'compaction').at(-1);
    assert.ok(!stock.fromHook);
    assert.equal(stock.details?.pajCaptainCompaction, undefined);
    assert.deepEqual(stock.details.readFiles, ['review.md']);
    assert.deepEqual(stock.details.modifiedFiles, ['draft.md']);
    assert.ok(f.requests.slice(offStart).every(value => !userText(value).includes(guidance)));
    assert.ok(JSON.stringify(f.requests.slice(offStart)).includes('OFF-MANUAL-FOCUS'));
  });

test('real Pi split-span compaction guides both stock summary calls and combines persisted usage',
  realPi, async t => {
    const f = await fixture(t, { split: true });
    await f.enable();
    const focus = 'SPLIT-FOCUS: do not relaunch uncertain workers';
    const result = await f.request('compact', { customInstructions: focus });
    assert.equal(f.preparations()[0].isSplitTurn, true);
    assert.ok(f.preparations()[0].history > 0);
    assert.ok(f.preparations()[0].prefix > 0);
    assert.equal(f.requests.length, 2, 'Stock split compaction only, not an extra rewrite');
    assertGuided(f.requests, focus);
    assertPersisted(f, result, 2);
  });

test('real Pi automatic threshold compaction uses guided hook and does not replay external actions',
  realPi, async t => {
    const f = await fixture(t, { automatic: true });
    await f.enable();
    const ledger = await f.seedUncertainTask();
    await f.prompt('Continue the coordination conversation without using tools.');
    const compacted = f.entries().filter(value => value.type === 'compaction');
    assert.equal(compacted.length, 1);
    assert.equal(compacted[0].details.pajCaptainCompaction, 1);
    assert.equal(f.preparations()[0].reason, 'threshold');
    const summaryRequests = f.requests.filter(value => value.summary);
    assert.equal(summaryRequests.length, 1);
    assertGuided(summaryRequests);
    assert.equal(f.requests.filter(value => !value.summary).length, 1, 'Only one continued model request');
    assert.deepEqual(f.ledgerFiles(), ledger);
    assert.ok(!f.events.some(event => event.type === 'tool_execution_start'));
    assert.ok(!existsSync(join(f.agent, 'captain', 'launches')));
  });

test('real Pi aborting a guided in-flight compaction persists no partial summary or fallback',
  realPi, async t => {
    const f = await fixture(t);
    await f.enable();
    const received = f.holdSummary();
    const compact = f.request('compact', { customInstructions: 'ABORT-FOCUS' }, false);
    await received;
    await f.request('abort');
    await compact;
    assert.equal(f.entries().filter(value => value.type === 'compaction').length, 0);
    assert.equal(f.requests.length, 1);
    assertGuided(f.requests, 'ABORT-FOCUS');
  });

test('real Pi guided summarization failure appends no compaction and does not fall back to stock',
  realPi, async t => {
    const f = await fixture(t);
    await f.enable();
    f.fail(true);
    const before = f.entries().filter(value => value.type === 'compaction').length;
    await f.request('compact', { customInstructions: 'FAILURE-FOCUS' }, false);
    assert.equal(f.entries().filter(value => value.type === 'compaction').length, before);
    assert.equal(f.requests.length, 1, 'Failure must cancel, not trigger an unguided fallback');
    assertGuided(f.requests, 'FAILURE-FOCUS');
  });
