import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { registerCaptain } from '../src/extension.ts';
import { captainPaths } from '../src/config.ts';

const voiceDir = process.env.PAJ_CAPTAIN_VOICE_DIR;
const integration = { skip: !voiceDir && 'Set PAJ_CAPTAIN_VOICE_DIR to a Voice source checkout with dev dependencies' };
const reply = 'The example agent is available but idle.';
const Type = Object.fromEntries(['Object', 'String', 'Optional', 'Array', 'Boolean']
  .map(name => [name, value => value]));

async function pair(t) {
  const { fixture } = await import(pathToFileURL(resolve(voiceDir, 'tests/fixtures/extension.js')).href);
  const voice = fixture();
  const root = mkdtempSync(join(tmpdir(), 'captain-voice-'));
  const handlers = new Map();
  const commands = new Map();
  const entries = [];
  const ctx = { ...voice.ctx, cwd: root, waitForIdle: async () => {},
    sessionManager: { ...voice.ctx.sessionManager, getBranch: () => entries } };
  const options = { paths: captainPaths({ PI_CODING_AGENT_DIR: root }),
    client: { self: async () => ({ id: 'captain-paj' }), incoming: async () => [] } };
  let active = ['read', ...voice.tools.keys()];
  const pi = { events: voice.pi.events, on: (name, handler) => handlers.set(name, handler),
    registerTool() {}, registerCommand: (name, command) => commands.set(name, command),
    getActiveTools: () => active, setActiveTools: value => { active = value; },
    appendEntry: (customType, data) => entries.push({ type: 'custom', customType, data }) };
  const load = () => registerCaptain(pi, Type, options);
  const captainEvent = (name, payload = {}) => handlers.get(name)?.(payload, ctx);
  const captain = value => commands.get('captain').handler(value, ctx);
  const events = voice.pi.events;
  t.after(async () => {
    try { await captainEvent('session_shutdown'); await voice.event('session_shutdown'); }
    finally { rmSync(root, { recursive: true, force: true }); }
  });
  events.on('paj:captain-inspection:v1', request => request.reply(Promise.resolve()));
  await voice.command('on');
  voice.audio({ type: 'ready' });
  load();
  await captainEvent('session_start');
  const start = async ({ inbox = false } = {}) => {
    const message = inbox ? { role: 'custom', customType: 'paj-messages', content: 'Synthetic worker report.',
      details: { messageIds: ['review'] } } : undefined;
    const startEvent = { systemPrompt: 'Original', messageType: inbox ? 'custom' : 'user', message };
    if (inbox) events.emit('paj:messages:delivering:v1', { sessionId: 'session-one',
      messageIds: ['review'], requestTurn() {} });
    else await voice.event('input', { source: 'extension', text: 'Give a short status answer.' });
    const prompt = await captainEvent('before_agent_start', startEvent);
    await voice.event('before_agent_start', startEvent);
    await voice.event('agent_start');
    const context = await voice.event('context', { messages: message ? [message] : [] });
    return { prompt, policy: context.messages.at(-1).content };
  };
  const finish = async (text = reply) => {
    await voice.event('message_end', { message: { role: 'assistant', stopReason: 'stop',
      content: [{ type: 'text', text }] } });
    await voice.event('agent_settled');
  };
  const queuedSpeech = () => voice.frames.filter(frame => frame.type === 'speak').map(frame => frame.text);
  return { voice, captain, captainEvent, load, start, finish, queuedSpeech, pi };
}

test('Captain ON and OFF both speak an eligible ordinary Voice final', integration, async t => {
  for (const on of [false, true]) {
    const f = await pair(t);
    if (on) await f.captain('on');
    const { prompt, policy } = await f.start();
    if (on) assert.match(prompt.systemPrompt, /You are Captain/);
    else assert.equal(prompt, undefined);
    await f.finish();
    assert.deepEqual(f.queuedSpeech(), [reply]);
    assert.match(policy, /short final plain-text reply is spoken automatically/);
  }
});

test('Captain keeps explicit speech tools available without duplicating answers', integration, async t => {
  const f = await pair(t);
  await f.captain('on');
  await f.start();
  assert.ok(f.pi.getActiveTools().includes('voice_speak'));
  const spoken = 'The example agent is idle.';
  const {generation, epoch} = f.voice.controller.state();
  const result = await f.voice.tools.get('voice_speak').execute('answer', {
    generation, epoch, purpose: 'answer', text: spoken,
  });
  assert.equal(result.details.status, 'queued');
  await f.finish();
  assert.deepEqual(f.queuedSpeech(), [spoken]);
});

test('Captain leaves independent Voice inbox summaries available', integration, async t => {
  const f = await pair(t);
  await f.captain('on');
  const { policy } = await f.start({ inbox: true });
  assert.match(policy, /Summarize the newly arrived Paj messages/);
  await f.finish('The worker completed the review and found no issues.');
  assert.deepEqual(f.queuedSpeech(), ['A Paj agent message arrived.', 'The worker completed the review and found no issues.']);
});

test('Voice stop and explicit silence still suppress a final with Captain on', integration, async t => {
  for (const stop of [true, false]) {
    const f = await pair(t);
    await f.captain('on');
    await f.start();
    if (stop) await f.voice.command('stop');
    else {
      assert.ok(f.pi.getActiveTools().includes('voice_silence_turn'));
      const {generation, epoch} = f.voice.controller.state();
      const result = await f.voice.tools.get('voice_silence_turn').execute('silence', {
        generation, epoch, turn: f.voice.controller.turn(),
      });
      assert.equal(result.details.status, 'silenced');
    }
    await f.finish();
    assert.deepEqual(f.queuedSpeech(), []);
  }
});

test('Captain toggling, reload and shutdown leave Voice narration ownership unchanged', integration, async t => {
  const f = await pair(t);
  const expectations = [
    [() => f.captain('on'), true],
    [() => f.captain('off'), false],
    [() => f.captain('on'), true],
    [async () => {
      await f.captainEvent('session_shutdown', { reason: 'reload' });
      f.load();
      await f.captainEvent('session_start', { reason: 'reload' });
    }, false],
    [() => f.captain('on'), true],
    [() => f.captainEvent('session_shutdown', { reason: 'quit' }), false],
  ];
  for (const [change, enabled] of expectations) {
    await change();
    const prompt = await f.captainEvent('before_agent_start', { systemPrompt: 'Original' });
    assert.equal(!!prompt, enabled);
    assert.equal(f.voice.controller.state().reportingOwner, null);
  }
});
