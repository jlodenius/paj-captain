import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createCaptainVoice } from '../src/voice.ts';
import { registerCaptain } from '../src/extension.ts';
import { captainPaths } from '../src/config.ts';

const API_EVENT = 'paj-voice:api:v1';
const STATE_EVENT = 'paj-voice:state:v1';

function bus() {
  const handlers = new Map();
  return {
    on(name, handler) {
      if (!handlers.has(name)) handlers.set(name, new Set());
      handlers.get(name).add(handler);
      return () => handlers.get(name).delete(handler);
    },
    emit(name, data) { for (const handler of [...(handlers.get(name) ?? [])]) handler(data); },
    count(name) { return handlers.get(name)?.size ?? 0; },
  };
}

function voiceAddon(events) {
  const registrations = [];
  const removals = [];
  const state = { enabled: false, eyesFree: false, sessionId: 'session', generation: 'generation',
    epoch: 1, reportingOwner: null };
  const api = {
    version: 1,
    getState: () => ({ ...state }),
    registerReporter(reporter) {
      registrations.push(reporter);
      state.reportingOwner = reporter.id;
      events.emit(STATE_EVENT, api.getState());
      let active = true;
      return () => {
        if (!active) return;
        active = false;
        removals.push(reporter.id);
        state.reportingOwner = null;
        events.emit(STATE_EVENT, api.getState());
      };
    },
  };
  const remove = events.on(API_EVENT, ({ reply }) => reply(api));
  events.emit(STATE_EVENT, api.getState());
  return { api, state, registrations, removals, remove };
}

test('voice absent, including a host without an event bus, remains harmless', () => {
  for (const events of [undefined, bus()]) {
    const captain = createCaptainVoice(events);
    captain.setEnabled(true);
    captain.refresh();
    captain.setEnabled(false);
    captain.setEnabled(false);
    if (events) assert.equal(events.count(STATE_EVENT), 0);
  }
});

test('either addon load order registers once, even while voice is off', () => {
  for (const voiceFirst of [false, true]) {
    const events = bus();
    const captain = createCaptainVoice(events);
    let voice;
    if (voiceFirst) voice = voiceAddon(events);
    captain.setEnabled(true);
    if (!voiceFirst) voice = voiceAddon(events);
    captain.setEnabled(true);
    captain.refresh();
    voice.state.enabled = true;
    voice.state.eyesFree = true;
    voice.state.epoch++;
    events.emit(STATE_EVENT, voice.api.getState());
    assert.equal(voice.registrations.length, 1);
    assert.equal(voice.state.reportingOwner, 'paj-captain');
    captain.setEnabled(false);
    captain.setEnabled(false);
    assert.deepEqual(voice.removals, ['paj-captain']);
    assert.equal(events.count(STATE_EVENT), 0);
    events.emit(STATE_EVENT, voice.api.getState());
    assert.equal(voice.registrations.length, 1);
    captain.setEnabled(true);
    assert.equal(voice.registrations.length, 2);
    captain.setEnabled(false);
  }
});

test('a failed registration can recover on a later state event without recursive retries', () => {
  const events = bus();
  const voice = voiceAddon(events);
  const register = voice.api.registerReporter;
  let attempts = 0;
  voice.api.registerReporter = reporter => {
    attempts++;
    if (attempts === 1) {
      events.emit(STATE_EVENT, voice.api.getState());
      throw new Error('temporarily unavailable');
    }
    return register(reporter);
  };
  const captain = createCaptainVoice(events);
  captain.setEnabled(true);
  assert.equal(attempts, 1);
  events.emit(STATE_EVENT, voice.api.getState());
  assert.equal(attempts, 2);
  assert.equal(voice.registrations.length, 1);
  captain.setEnabled(false);
  assert.equal(voice.removals.length, 1);
});

test('reporter instructions select semantic speech without changing detailed screen answers', () => {
  const events = bus();
  const voice = voiceAddon(events);
  const captain = createCaptainVoice(events);
  captain.setEnabled(true);
  const { id, instructions } = voice.registrations[0];
  assert.equal(id, 'paj-captain');
  for (const pattern of [/voice_speak/, /30 words/, /questions, blockers and results/,
    /eyes-free/, /reporting\.progress is false/, /never narrate tools or read raw worker reports/,
    /duplicate generic completion summaries/, /detailed screen answers unchanged/,
    /Never send the full response/, /runtime enforces the maximum/]) assert.match(instructions, pattern);
  captain.setEnabled(false);
});

test('interface disappearance and replacement release the old registration before reacquiring', () => {
  const events = bus();
  const first = voiceAddon(events);
  const captain = createCaptainVoice(events);
  captain.setEnabled(true);
  first.remove();
  events.emit(STATE_EVENT, null);
  assert.deepEqual(first.removals, ['paj-captain']);
  const second = voiceAddon(events);
  assert.equal(second.registrations.length, 1);
  second.remove();
  const third = voiceAddon(events);
  assert.deepEqual(second.removals, ['paj-captain']);
  assert.equal(third.registrations.length, 1);
  captain.setEnabled(false);
  assert.deepEqual(third.removals, ['paj-captain']);
});

test('query, incompatible APIs, registration and cleanup failures never break Captain', () => {
  for (const candidate of [null, { version: 2 }, { version: 1 },
    { version: 1, getState() {}, registerReporter() { throw new Error('unavailable'); } }]) {
    const events = bus();
    events.on(API_EVENT, ({ reply }) => reply(candidate));
    const captain = createCaptainVoice(events);
    captain.setEnabled(true);
    captain.refresh();
    captain.setEnabled(false);
  }
  const events = bus();
  const fail = events.on(API_EVENT, () => { throw new Error('query failed'); });
  const captain = createCaptainVoice(events);
  captain.setEnabled(true);
  fail();
  let cleaned = 0;
  events.on(API_EVENT, ({ reply }) => reply({ version: 1, getState() {},
    registerReporter() { return () => { cleaned++; throw new Error('cleanup failed'); }; } }));
  events.emit(STATE_EVENT, null);
  captain.setEnabled(false);
  assert.equal(cleaned, 1);
  assert.equal(events.count(STATE_EVENT), 0);
});

function extensionFixture(t, events) {
  const root = mkdtempSync(join(tmpdir(), 'captain-voice-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const handlers = new Map();
  const commands = new Map();
  const entries = [];
  let active = ['read', 'voice_speak'];
  const pi = { events, on: (name, handler) => handlers.set(name, handler),
    registerTool() {}, registerCommand: (name, command) => commands.set(name, command),
    getActiveTools: () => active, setActiveTools: value => { active = value; },
    appendEntry: (customType, data) => entries.push({ type: 'custom', customType, data }) };
  const ctx = { cwd: root, waitForIdle: async () => {}, ui: { setStatus() {}, notify() {} },
    sessionManager: { getSessionId: () => 'captain-session', getBranch: () => entries } };
  const Type = Object.fromEntries(['Object', 'String', 'Optional', 'Array', 'Boolean']
    .map(name => [name, value => value]));
  const options = { paths: captainPaths({ PI_CODING_AGENT_DIR: root }),
    client: { self: async () => ({ id: 'captain-paj' }), incoming: async () => [] } };
  const load = () => registerCaptain(pi, Type, options);
  load();
  return { load, entries, command: args => commands.get('captain').handler(args, ctx),
    event: (name, event = {}) => handlers.get(name)(event, ctx), pi, ctx };
}

test('Captain lifecycle enables, disables, restores, reloads and shuts down its reporter', async t => {
  const events = bus();
  const voice = voiceAddon(events);
  const f = extensionFixture(t, events);
  await f.event('session_start');
  assert.equal(voice.registrations.length, 0);
  await f.command('on');
  await f.command('on');
  const prompt = await f.event('before_agent_start', { systemPrompt: 'Original' });
  assert.match(prompt.systemPrompt, /^Original/);
  assert.match(prompt.systemPrompt, /keep routine progress quiet/);
  assert.doesNotMatch(prompt.systemPrompt, /voice_speak/);
  assert.ok(f.pi.getActiveTools().includes('voice_speak'));
  assert.equal(voice.registrations.length, 1);
  await f.command('off');
  assert.equal(voice.removals.length, 1);
  await f.command('on');
  await f.event('session_shutdown', { reason: 'reload' });
  assert.equal(voice.removals.length, 2);
  assert.equal(events.count(STATE_EVENT), 0);
  f.load();
  await f.event('session_start', { reason: 'reload' });
  assert.equal(voice.registrations.length, 3);
  assert.equal(events.count(STATE_EVENT), 1);
  f.entries.length = 0;
  await f.event('session_tree');
  assert.equal(voice.removals.length, 3);
  await f.event('session_shutdown', { reason: 'new' });
  f.load();
  await f.event('session_start', { reason: 'new' });
  assert.equal(voice.registrations.length, 3);
});

async function realVoice(t) {
  if (!process.env.PAJ_CAPTAIN_VOICE_DIR) {
    t.skip('Set PAJ_CAPTAIN_VOICE_DIR to enable optional voice integration tests');
    return;
  }
  const root = pathToFileURL(`${resolve(process.env.PAJ_CAPTAIN_VOICE_DIR)}/`);
  const controller = new URL('src/controller.ts', root);
  const extension = new URL('src/extension.ts', root);
  if (!existsSync(controller) || !existsSync(extension)) {
    t.skip('PAJ_CAPTAIN_VOICE_DIR must contain the maintained TypeScript voice sources');
    return;
  }
  return { ...await import(controller.href), ...await import(extension.href) };
}

test('real voice controller retains one Captain reporter across readiness, interruptions and generations', async t => {
  const modules = await realVoice(t);
  if (!modules) return;
  for (const voiceFirst of [false, true]) {
    const events = bus();
    const frames = [];
    const controller = modules.createVoiceController({
      submit() { throw new Error('No model submissions expected'); },
      send: frame => frames.push(frame), changed: state => events.emit(STATE_EVENT, state),
    });
    let registrations = 0;
    let removals = 0;
    const register = controller.api.registerReporter;
    controller.api.registerReporter = params => {
      registrations++;
      const unregister = register(params);
      return () => { removals++; unregister(); };
    };
    const captain = createCaptainVoice(events);
    const install = () => {
      events.on(API_EVENT, ({ reply }) => reply(controller.api));
      events.emit(STATE_EVENT, controller.state());
    };
    if (voiceFirst) install();
    captain.setEnabled(true);
    if (!voiceFirst) install();
    const instructions = controller.instructions();
    assert.match(instructions, /Captain orchestration reports/);
    assert.equal(controller.state().reportingOwner, 'paj-captain');
    assert.equal(controller.state().enabled, false);
    const first = controller.start('captain-session');
    assert.equal(first.starting, true);
    controller.event({ type: 'ready' }, first.generation);
    assert.equal(controller.state().enabled, true);
    assert.equal(controller.state().eyesFree, true);
    controller.newRun();
    const state = controller.state();
    assert.equal(controller.api.speak({ text: 'The worker finished the requested checks.',
      generation: state.generation, epoch: state.epoch }).status, 'queued');
    controller.settled();
    assert.deepEqual(frames.filter(frame => frame.type === 'speak').map(frame => frame.text),
      ['The worker finished the requested checks.', 'I’m finished for now.']);
    controller.event({ type: 'addressed', id: 'interruption' }, first.generation);
    assert.ok(controller.state().epoch > state.epoch);
    assert.equal(controller.api.speak({ text: 'Stale report.', generation: state.generation,
      epoch: state.epoch }).status, 'stale');
    controller.event({ type: 'cancelled', id: 'interruption' }, first.generation);
    controller.mute(true);
    controller.mute(false);
    controller.silence();
    controller.stop();
    assert.equal(controller.instructions(), instructions);
    const second = controller.start('captain-session');
    assert.notEqual(second.generation, first.generation);
    controller.event({ type: 'ready' }, second.generation);
    captain.refresh();
    captain.setEnabled(true);
    assert.equal(registrations, 1);
    assert.equal(removals, 0);
    assert.equal(controller.instructions(), instructions);
    captain.setEnabled(false);
    assert.equal(controller.instructions(), null);
    assert.equal(controller.state().reportingOwner, null);
    assert.equal(removals, 1);
    captain.setEnabled(true);
    assert.equal(registrations, 2);
    captain.setEnabled(false);
    controller.stop();
    assert.equal(removals, 2);
  }
});

test('real voice extension selects Captain policy, restores ordinary policy and tears down in either order', async t => {
  const modules = await realVoice(t);
  if (!modules) return;
  for (const voiceFirst of [false, true]) {
    for (const voiceShutdownFirst of [false, true]) {
      for (const voiceReadyAtShutdown of [false, true]) {
        const events = bus();
        const f = extensionFixture(t, events);
        const voiceHandlers = new Map();
        const Type = Object.fromEntries(['Object', 'String', 'Integer', 'Optional']
          .map(name => [name, value => value]));
        let voice;
        const install = () => {
          voice = modules.registerVoice({ ...f.pi,
            on: (name, handler) => voiceHandlers.set(name, handler),
          }, Type, {
            env: {},
            startCompanion() { throw new Error('No microphone or audio process expected'); },
          });
          voiceHandlers.get('session_start')({}, f.ctx);
        };
        if (voiceFirst) install();
        await f.command('on');
        if (!voiceFirst) install();
        const context = () => voiceHandlers.get('context')({ messages: [] }, f.ctx);
        assert.equal(context(), undefined);
        const state = voice.controller.start('captain-session');
        voice.controller.event({ type: 'ready' }, state.generation);
        let policy = context().messages.at(-1).content;
        assert.match(policy, /Captain orchestration reports/);
        assert.match(policy, /reporting\.progress is false/);
        assert.match(policy, /normal detailed screen answers unchanged/);
        assert.ok(policy.includes(voice.controller.instructions()));
        assert.doesNotMatch(policy, /For a simple answer/);
        const ordinary = await f.event('before_agent_start', { systemPrompt: 'Original screen policy' });
        assert.match(ordinary.systemPrompt, /^Original screen policy/);
        assert.match(ordinary.systemPrompt, /keep routine progress quiet/);
        await f.command('off');
        assert.equal(voice.controller.state().reportingOwner, null);
        assert.equal(voice.controller.instructions(), null);
        policy = context().messages.at(-1).content;
        assert.match(policy, /For a simple answer/);
        assert.doesNotMatch(policy, /Captain orchestration reports/);
        await f.command('on');
        assert.equal(voice.controller.state().reportingOwner, 'paj-captain');
        if (!voiceReadyAtShutdown) voice.stop();
        if (voiceShutdownFirst) {
          voiceHandlers.get('session_shutdown')({ reason: 'reload' }, f.ctx);
          await f.event('before_agent_start', { systemPrompt: 'Refresh after voice teardown' });
          assert.equal(voice.controller.instructions(), null);
          await f.event('session_shutdown', { reason: 'reload' });
        } else {
          await f.event('session_shutdown', { reason: 'reload' });
          assert.equal(voice.controller.instructions(), null);
          voiceHandlers.get('session_shutdown')({ reason: 'reload' }, f.ctx);
        }
        assert.equal(voice.controller.state().reportingOwner, null);
        assert.equal(events.count(API_EVENT), 0);
        assert.equal(events.count(STATE_EVENT), 0);
      }
    }
  }
});
