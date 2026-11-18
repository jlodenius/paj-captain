import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, statSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { registerCaptain } from '../src/extension.ts';
import { saveConfig, captainPaths, loadConfig } from '../src/config.ts';

const Type = Object.fromEntries(['Object', 'String', 'Optional', 'Array', 'Boolean']
  .map(name => [name, value => ({ type: name, value })]));
const ownPiId = '20000000-0000-4000-8000-000000000001';
const self = { id: '10000000-0000-4000-8000-000000000001', piSessionId: ownPiId,
  name: 'captain', role: 'primary', parentPiSessionId: null, projectRoot: '/projects/captain',
  cwd: '/projects/captain', projectId: 'captain-project', pid: 123, status: 'idle' };
const worker = { ...self, id: '10000000-0000-4000-8000-000000000002',
  piSessionId: '20000000-0000-4000-8000-000000000002', name: 'worker', projectRoot: '/elsewhere', cwd: '/elsewhere' };

function fixture(t, overrides = {}) {
  const root = mkdtempSync(join(tmpdir(), 'captain-extension-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const paths = captainPaths({ PI_CODING_AGENT_DIR: root });
  const messages = [];
  const calls = [];
  const entries = [];
  const notices = [];
  const inspection = [];
  const handlers = new Map();
  const tools = new Map();
  const commands = new Map();
  let active = ['read', 'bash', 'send_agent_message', 'spawn_sub_agent'];
  const client = {
    self: async id => { calls.push(['self', id]); return self; },
    listMain: async () => [worker],
    resolveMain: async name => { if (name !== worker.id && name !== worker.name) throw new Error('Not a live main agent'); return worker; },
    incoming: async () => messages,
    send: async args => { calls.push(['send', args]); return { id: '30000000-0000-4000-8000-000000000001',
      from: { id: self.id, name: self.name }, to: args.recipient, text: args.text, kind: args.kind,
      taskId: args.taskId, inReplyTo: args.inReplyTo, createdAtMs: Date.now() }; },
    ...overrides.client,
  };
  const pi = {
    events: { emit: (name, data) => { if (name === 'paj:captain-inspection') inspection.push(data); } },
    registerTool: tool => { tools.set(tool.name, tool); if (tool.exposure === 'direct') active = [...new Set([...active, tool.name])]; },
    getActiveTools: () => active,
    setActiveTools: names => { active = names; },
    registerCommand: (name, command) => commands.set(name, command),
    appendEntry: (customType, data) => entries.push({ type: 'custom', customType, data }),
    on: (event, handler) => { handlers.set(event, handler); },
  };
  const ctx = { cwd: root, sessionManager: { getSessionId: () => ownPiId, getBranch: () => entries },
    ui: { setStatus() {}, notify: (...args) => notices.push(args) }, waitForIdle: async () => {} };
  registerCaptain(pi, Type, { piVersion: '1.5.2', ...overrides, paths, client });
  return { root, paths, client, calls, entries, notices, inspection, handlers, tools, pi, ctx,
    command: args => commands.get('captain').handler(args, ctx),
    tool: (name, params = {}, id = 'tool-call') => tools.get(name).execute(id, params, undefined, undefined, ctx),
    event: (name, event = {}) => handlers.get(name)(event, ctx) };
}

function compactionEvent(entries = []) {
  return { branchEntries: entries, signal: new AbortController().signal, preparation: {
    firstKeptEntryId: 'kept-entry', tokensBefore: 12000, previousSummary: undefined,
    fileOps: { read: new Set(), written: new Set(), edited: new Set() },
  } };
}

function compactionContext(f) {
  f.ctx.model = { id: 'test-model', api: 'test-api' };
  f.ctx.modelRegistry = { streamSimple() { throw new Error('Unexpected provider call'); } };
}

const compactResult = preparation => ({ summary: 'Reviewed summary',
  firstKeptEntryId: preparation.firstKeptEntryId, tokensBefore: preparation.tokensBefore,
  details: { readFiles: [], modifiedFiles: [] }, usage: { totalTokens: 10 } });

test('compaction stays stock while dormant, after disabling, and in a new session', async t => {
  let calls = 0;
  const f = fixture(t, { compact: async preparation => { calls++; return compactResult(preparation); } });
  compactionContext(f);
  const event = compactionEvent(f.entries);
  const fileOps = event.preparation.fileOps;
  assert.equal(await f.event('session_before_compact', event), undefined);
  assert.equal(event.preparation.fileOps, fileOps);
  assert.equal(calls, 0);
  await f.command('on');
  assert.equal((await f.event('session_before_compact', event)).compaction.details.pajCaptainCompaction, 1);
  await f.command('off');
  assert.equal(await f.event('session_before_compact', event), undefined);
  f.entries.length = 0;
  await f.event('session_start');
  assert.equal(await f.event('session_before_compact', event), undefined);
  assert.equal(calls, 1);
});

test('explicitly reactivated Captain retains the compaction hook and preserves result metadata', async t => {
  const f = fixture(t, { compact: async preparation => compactResult(preparation) });
  compactionContext(f);
  await f.command('on');
  await f.event('session_start');
  await f.command('on');
  const result = await f.event('session_before_compact', compactionEvent(f.entries));
  assert.equal(result.compaction.summary, 'Reviewed summary');
  assert.deepEqual(result.compaction.usage, { totalTokens: 10 });
  assert.equal(result.compaction.firstKeptEntryId, 'kept-entry');
});

test('enabled turns remind Captain to reread the complete skill after compaction', async t => {
  const f = fixture(t, { compact: async preparation => compactResult(preparation) });
  compactionContext(f);
  await f.command('on');
  for (const compacted of [false, true]) {
    if (compacted) await f.event('session_before_compact', compactionEvent(f.entries));
    const { systemPrompt } = await f.event('before_agent_start', { systemPrompt: 'Original' });
    assert.match(systemPrompt, /Read the complete .*skills\/paj-captain\/SKILL\.md/);
    assert.match(systemPrompt, /After compaction, read it again even if you read it earlier in the session/);
    assert.match(systemPrompt, /captain_tasks for current assignment details/);
  }
  await f.command('off');
  assert.equal(await f.event('before_agent_start', { systemPrompt: 'Original' }), undefined);
});

test('disabling Captain mid-compaction cancels instead of accepting stale results', async t => {
  let f;
  f = fixture(t, { compact: async preparation => { await f.command('off'); return compactResult(preparation); } });
  compactionContext(f);
  await f.command('on');
  assert.deepEqual(await f.event('session_before_compact', compactionEvent(f.entries)), { cancel: true });
  assert.match(f.notices.at(-1)[0], /mode changed/);
});

test('old, missing, and prerelease Pi runtimes cannot silently omit split-summary guidance', async t => {
  for (const piVersion of [undefined, '1.2.0', '1.5.1', '1.5.2-dev', 'invalid']) {
    let calls = 0;
    const f = fixture(t, { piVersion, compact: async preparation => { calls++; return compactResult(preparation); } });
    compactionContext(f);
    await f.command('on');
    assert.deepEqual(await f.event('session_before_compact', compactionEvent(f.entries)), { cancel: true });
    assert.equal(calls, 0);
    assert.match(f.notices.at(-1)[0], /requires Pi 1.5.2/);
  }
});

test('settings or notification failures cannot cause unguided fallback', async t => {
  const f = fixture(t);
  await f.command('on');
  f.pi.getSettings = () => { throw new Error('Settings unavailable'); };
  f.ctx.ui.notify = () => { throw new Error('Notification unavailable'); };
  assert.deepEqual(await f.event('session_before_compact', compactionEvent(f.entries)), { cancel: true });
});

test('stock compaction after Captain off carries its last structured file metadata', async t => {
  const f = fixture(t);
  const previous = { type: 'compaction', fromHook: true, summary: 'Previous summary',
    details: { pajCaptainCompaction: 1, readFiles: ['old.txt'], modifiedFiles: ['edited.txt'] } };
  f.entries.push(previous);
  const event = compactionEvent(f.entries);
  event.preparation.previousSummary = previous.summary;
  const original = event.preparation.fileOps;
  assert.equal(await f.event('session_before_compact', event), undefined);
  assert.deepEqual([...event.preparation.fileOps.read], ['old.txt']);
  assert.deepEqual([...event.preparation.fileOps.edited], ['edited.txt']);
  assert.equal(original.read.size, 0);
  previous.details.readFiles = null;
  assert.deepEqual(await f.event('session_before_compact', event), { cancel: true });
});

test('ordinary sessions stay dormant and disabled tools cannot execute', async t => {
  const f = fixture(t);
  await f.event('session_start');
  assert.equal(f.calls.length, 0);
  assert.equal(existsSync(f.paths.stateDir), false);
  assert.ok([...f.tools.values()].every(tool => tool.exposure === 'hidden'));
  assert.equal(await f.event('before_agent_start', { systemPrompt: 'Original' }), undefined);
  await assert.rejects(f.tool('captain_agents'), /Run \/captain/);
});

test('/captain activates only this session and preserves the existing system prompt', async t => {
  const f = fixture(t);
  await f.command('');
  assert.ok(f.pi.getActiveTools().includes('captain_delegate'));
  assert.ok(!f.pi.getActiveTools().includes('spawn_sub_agent'));
  assert.ok(f.pi.getActiveTools().includes('bash'));
  const prompt = await f.event('before_agent_start', { systemPrompt: 'Original repository instructions' });
  assert.ok(prompt.systemPrompt.startsWith('Original repository instructions\n'));
  assert.match(prompt.systemPrompt, /MAIN agents/);
  assert.match(prompt.systemPrompt, /almost no project work/);
  assert.match(prompt.systemPrompt, /even when busy/);
  assert.match(prompt.systemPrompt, /OWN regular subagent reviews/);
  assert.match(f.tools.get('captain_start_agent').description, /Only when no relevant existing MAIN/);
  assert.match(f.tools.get('captain_delegate').description, /resolve findings/);
  assert.match(prompt.systemPrompt, /keep routine progress quiet/);
  assert.equal(f.entries.at(-1).data.enabled, true);
  await f.command('off');
  assert.ok(f.pi.getActiveTools().includes('spawn_sub_agent'));
  assert.ok(!f.pi.getActiveTools().includes('captain_delegate'));
  assert.equal(await f.event('before_agent_start', { systemPrompt: 'Original' }), undefined);
});

test('activation requires a live main Paj identity and reports failure without enabling', async t => {
  const f = fixture(t, { client: { self: async () => { throw new Error('Paj is not available'); } } });
  await f.command('');
  assert.ok(!f.pi.getActiveTools().includes('captain_agents'));
  assert.equal(f.entries.length, 0);
  assert.ok(!f.inspection.some(data => data.enabled));
  assert.match(f.notices.at(-1)[0], /Paj is not available/);
});

test('failed inspection publication rolls activation back to ordinary mode', async t => {
  const f = fixture(t);
  f.pi.events.emit = (name, data) => {
    assert.equal(name, 'paj:captain-inspection');
    f.inspection.push(data);
    if (data.enabled) throw new Error('Inspection publication failed');
  };
  await f.command('on');
  assert.deepEqual(f.inspection, [{ enabled: true }, { enabled: false }]);
  assert.ok(!f.pi.getActiveTools().includes('captain_agents'));
  assert.ok(f.pi.getActiveTools().includes('spawn_sub_agent'));
  assert.equal(f.entries.length, 0);
  assert.match(f.notices.at(-1)[0], /Inspection publication failed/);
});

test('all lifecycle boundaries revoke Captain inspection and never restore historical mode', async t => {
  const f = fixture(t);
  for (const reason of ['startup', 'reload', 'new', 'resume', 'fork']) {
    await f.command('on');
    assert.deepEqual(f.inspection.at(-1), { enabled: true });
    await f.event('session_shutdown', { reason });
    assert.deepEqual(f.inspection.at(-1), { enabled: false });
    await f.event('session_start', { reason });
    assert.ok(!f.pi.getActiveTools().includes('captain_agents'));
    assert.deepEqual(f.inspection.at(-1), { enabled: false });
    assert.equal(await f.event('before_agent_start', { systemPrompt: 'Original' }), undefined);
  }
  await f.command('on');
  await f.event('session_tree');
  assert.ok(!f.pi.getActiveTools().includes('captain_agents'));
  assert.deepEqual(f.inspection.at(-1), { enabled: false });
  assert.ok(f.entries.some(entry => entry.data.enabled));
  assert.ok(!f.tools.has('captain_mode'));
});

test('pending activation cannot outlive off, shutdown, navigation or a changed session', async t => {
  for (const boundary of ['off', 'session_shutdown', 'session_tree', 'identity']) {
    let resolve;
    let checking;
    const checked = new Promise(done => { checking = done; });
    const f = fixture(t, { client: { self: () => {
      checking();
      return new Promise(done => { resolve = done; });
    } } });
    const activation = f.command('on');
    await checked;
    if (boundary === 'off') await f.command('off');
    else if (boundary === 'identity') f.ctx.sessionManager.getSessionId = () => 'different-session';
    else await f.event(boundary);
    resolve(self);
    await activation;
    assert.ok(!f.inspection.some(data => data.enabled), boundary);
    assert.ok(!f.pi.getActiveTools().includes('captain_agents'), boundary);
  }
});

test('subagent tools and untracked requests are blocked while main-only questions remain possible', async t => {
  const f = fixture(t);
  await f.command('');
  assert.equal((await f.event('tool_call', { toolName: 'spawn_sub_agent', input: {} })).block, true);
  assert.equal((await f.event('tool_call', { toolName: 'send_agent_message', input: { recipient: worker.id, kind: 'request' } })).block, true);
  assert.equal(await f.event('tool_call', { toolName: 'send_agent_message', input: { recipient: worker.id, kind: 'question' } }), undefined);
  assert.equal((await f.event('tool_call', { toolName: 'send_agent_message', input: { recipient: 'child', kind: 'question' } })).block, true);
});

test('shared Paj inspection authorizes child observation while messaging remains main-only', async t => {
  const f = fixture(t);
  f.pi.setActiveTools([...f.pi.getActiveTools(), 'inspect_agent']);
  await f.command('');
  const prompt = await f.event('before_agent_start', { systemPrompt: 'Original' });
  assert.match(prompt.systemPrompt, /use Paj inspect_agent/);
  assert.equal(await f.event('tool_call', { toolName: 'inspect_agent', input: { recipient: worker.id } }), undefined);
  assert.equal(await f.event('tool_call', { toolName: 'inspect_agent', input: { recipient: 'child' } }), undefined);
  assert.match(prompt.systemPrompt, /direct all instructions through the owning main/);
  assert.equal((await f.event('tool_call', { toolName: 'send_agent_message',
    input: { recipient: 'child', kind: 'update' } })).block, true);
  await f.command('off');
  assert.equal(await f.event('tool_call', { toolName: 'inspect_agent', input: { recipient: 'child' } }), undefined);
});

test('missing shared inspection is explicit rather than assumed to provide live access', async t => {
  const f = fixture(t);
  await f.command('');
  const prompt = await f.event('before_agent_start', { systemPrompt: 'Original' });
  assert.match(prompt.systemPrompt, /Live inspection is unavailable/);
});

test('delegation persists a queued task, accepts a worker outside launch roots and does not resend', async t => {
  const f = fixture(t);
  await f.command('');
  const first = (await f.tool('captain_delegate', { recipient: worker.id, assignment: 'Review changes. Report checks.' })).details;
  assert.equal(first.status, 'queued');
  await f.tool('captain_delegate', { recipient: worker.id, assignment: 'Review changes. Report checks.' });
  assert.equal(f.calls.filter(call => call[0] === 'send').length, 1);
  const tasks = (await f.tool('captain_tasks')).details;
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].id, first.id);
});

test('unknown delivery remains visible and is never automatically resent', async t => {
  const f = fixture(t, { client: { send: async args => { f.calls.push(['send', args]); throw new Error('Timeout after dispatch'); } } });
  await f.command('');
  const task = (await f.tool('captain_delegate', { recipient: worker.id, assignment: 'Finite task' })).details;
  assert.equal(task.status, 'delivery_unknown');
  await f.tool('captain_delegate', { recipient: worker.id, assignment: 'Finite task' });
  assert.equal(f.calls.filter(call => call[0] === 'send').length, 1);
});

test('launch receives freshly read policy and stable request identity, and shutdown does not stop workers', async t => {
  const launches = [];
  const f = fixture(t, { launchMain: async (...args) => { launches.push(args); return { status: 'launched' }; } });
  await f.command('');
  saveConfig(f.paths.configFile, { workspaces: { allow: ['~/Development/**', '~/.nixos'] } });
  await f.tool('captain_start_agent', { workspace: '~/.nixos' }, 'launch-id');
  assert.deepEqual(launches[0][1].allow, ['~/Development/**', '~/.nixos']);
  assert.equal(launches[0][0].requestId, `${ownPiId}:launch-id`);
  await f.event('session_shutdown');
  assert.equal(launches.length, 1);
});

test('settings update only the shared Captain section and are reflected in the next prompt', async t => {
  const f = fixture(t);
  const siblings = { subagents: { future: ['opaque'] }, voice: { future: true }, other: null };
  writeFileSync(f.paths.configFile, JSON.stringify(siblings));
  await f.command('');
  await f.tool('captain_settings', { allow: ['~/Development/**', '~/.nixos'], progress: true, verbosity: 'detailed' });
  const config = loadConfig(f.paths.configFile);
  assert.equal(config.reporting.progress, true);
  assert.deepEqual(JSON.parse(readFileSync(f.paths.configFile, 'utf8')), { ...siblings, captain: config });
  assert.equal(f.paths.configFile, join(f.root, 'paj.json'));
  const prompt = await f.event('before_agent_start', { systemPrompt: 'Original' });
  assert.match(prompt.systemPrompt, /include useful progress/);
  assert.match(prompt.systemPrompt, /detailed/);
});

test('aborting during target resolution prevents an unsubmitted delegation', async t => {
  const controller = new AbortController();
  const f = fixture(t, { client: { resolveMain: async () => { controller.abort(); return worker; } } });
  await f.command('');
  await assert.rejects(f.tools.get('captain_delegate').execute('cancelled',
    { recipient: worker.id, assignment: 'Must not dispatch' }, controller.signal, undefined, f.ctx));
  assert.equal(f.calls.filter(call => call[0] === 'send').length, 0);
});

test('malformed live configuration keeps a protective Captain prompt and blocks delegation', async t => {
  const f = fixture(t);
  await f.command('');
  writeFileSync(f.paths.configFile, '{');
  const prompt = await f.event('before_agent_start', { systemPrompt: 'Original' });
  assert.match(prompt.systemPrompt, /configuration is invalid/);
  await assert.rejects(f.tool('captain_delegate', { recipient: worker.id, assignment: 'Do not dispatch' }));
  assert.equal(f.calls.filter(call => call[0] === 'send').length, 0);
});

test('large tool output is bounded and the complete private result remains readable', async t => {
  const large = Array.from({ length: 100 }, (_, index) => ({ ...worker, name: `${index}-${'x'.repeat(1000)}` }));
  const f = fixture(t, { client: { listMain: async () => large } });
  await f.command('');
  const output = await f.tool('captain_agents');
  assert.equal(output.details.truncated, true);
  t.after(() => rmSync(dirname(output.details.fullOutputPath), { recursive: true, force: true }));
  assert.ok(Buffer.byteLength(output.content[0].text) < 32768);
  assert.equal(statSync(output.details.fullOutputPath).mode & 0o777, 0o600);
  assert.deepEqual(JSON.parse(readFileSync(output.details.fullOutputPath, 'utf8')), large);
});
