import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { CAPTAIN_COMPACTION_GUIDANCE, carryCaptainFiles, compactCaptain } from '../src/compaction.ts';

async function installedCompact() {
  const require = createRequire(import.meta.url);
  const candidates = [];
  if (!process.env.PAJ_CAPTAIN_PI_BIN) {
    try { candidates.push(require.resolve('@earendil-works/pi-coding-agent')); } catch {}
  }
  const binaries = process.env.PAJ_CAPTAIN_PI_BIN ? [process.env.PAJ_CAPTAIN_PI_BIN]
    : (process.env.PATH ?? '').split(':').map(path => join(path, 'pi'));
  for (const binary of binaries) {
    if (!existsSync(binary)) continue;
    const resolved = realpathSync(binary);
    candidates.push(join(dirname(resolved), '../lib/node_modules/pi-monorepo/dist/index.js'));
    const wrapper = readFileSync(resolved, 'utf8');
    for (const match of wrapper.matchAll(/(\/nix\/store\/[^\s"']+)\/bin\/\.?pi(?:-wrapped)?/g)) {
      candidates.push(join(match[1], 'lib/node_modules/pi-monorepo/dist/index.js'));
    }
  }
  let unsupported;
  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue;
    const sdk = await import(pathToFileURL(candidate).href);
    const version = /^(\d+)\.(\d+)\.(\d+)$/.exec(sdk.VERSION ?? '')?.slice(1).map(Number);
    if (version && (version[0] > 1 || (version[0] === 1
      && (version[1] > 5 || (version[1] === 5 && version[2] >= 2))))) {
      assert.equal(typeof sdk.compact, 'function');
      return { compact: sdk.compact, version: sdk.VERSION };
    }
    unsupported = `Installed Pi SDK ${sdk.VERSION ?? 'unknown'} is below required 1.5.2`;
  }
  assert.ok(!process.env.PAJ_CAPTAIN_PI_BIN,
    unsupported ?? `No Pi SDK found for explicit PAJ_CAPTAIN_PI_BIN=${process.env.PAJ_CAPTAIN_PI_BIN}`);
  return { skip: unsupported ?? 'Installed Pi SDK >=1.5.2 not found' };
}

const installed = await installedCompact();
const realCompact = installed.compact;
const realOptions = { skip: !realCompact && installed.skip };
const model = { provider: 'test-provider', id: 'test-model', api: 'test-api', maxTokens: 4096, reasoning: true };

function usage(input = 10, output = 5) {
  return { input, output, cacheRead: 0, cacheWrite: 0, totalTokens: input + output,
    cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, total: 3 } };
}

function response(overrides = {}) {
  return { role: 'assistant', provider: model.provider, model: model.id, api: model.api,
    timestamp: 0, content: [{ type: 'text', text: 'A useful summary' }], stopReason: 'stop',
    usage: usage(), ...overrides };
}

function preparation(overrides = {}) {
  return { firstKeptEntryId: 'keep-me', tokensBefore: 12345,
    messagesToSummarize: [{ role: 'user', content: 'History to summarize', timestamp: 0 }],
    turnPrefixMessages: [], isSplitTurn: false,
    settings: { enabled: true, reserveTokens: 1000, keepRecentTokens: 100 },
    fileOps: { read: new Set(['read.txt']), written: new Set(), edited: new Set(['edit.txt']) },
    ...overrides };
}

function fixture({ prep = preparation(), replies = [], signal = new AbortController().signal,
  selectedModel = model, customInstructions, branchEntries = [] } = {}) {
  const calls = [];
  const notices = [];
  const registry = {
    streamSimple(selected, context, options) {
      assert.equal(this, registry);
      calls.push({ model: selected, context, options });
      const next = replies.length ? replies.shift() : response();
      const result = Promise.resolve().then(() => typeof next === 'function' ? next() : next);
      return { result: () => result };
    },
  };
  return { event: { preparation: prep, branchEntries, customInstructions, signal,
    reason: 'manual', willRetry: false }, ctx: { model: selectedModel, modelRegistry: registry,
    ui: { notify: (message, level) => notices.push({ message, level }) } }, calls, notices };
}

function run(f, options = {}) {
  return compactCaptain(f.event, f.ctx, { compact: realCompact, ...options });
}

function ownEntry(summary = 'previous', readFiles = ['old-read'], modifiedFiles = ['old-edit']) {
  return { type: 'compaction', fromHook: true, summary,
    details: { pajCaptainCompaction: 1, readFiles, modifiedFiles } };
}

function occurrences(text, needle) {
  return text.split(needle).length - 1;
}

test('real helper preserves boundaries, usage, settings and input while applying focus exactly once', realOptions, async () => {
  const prep = preparation({ previousSummary: 'PREVIOUS_SUMMARY' });
  const before = structuredClone(prep);
  const f = fixture({ prep, customInstructions: 'MANUAL_FOCUS' });
  const result = await run(f, { thinkingLevel: 'high' });
  assert.equal(f.calls.length, 1);
  const call = f.calls[0];
  assert.deepEqual(call.context.messages.map(message => message.role), ['system', 'user']);
  assert.equal(call.context.systemPrompt, undefined);
  assert.equal(occurrences(JSON.stringify(call.context.messages[1]), 'MANUAL_FOCUS'), 1);
  assert.equal(occurrences(JSON.stringify(call.context.messages[0]), 'MANUAL_FOCUS'), 0);
  const prompt = JSON.stringify(call.context);
  assert.equal(occurrences(prompt, JSON.stringify(CAPTAIN_COMPACTION_GUIDANCE).slice(1, -1)), 1);
  assert.equal(occurrences(prompt, 'MANUAL_FOCUS'), 1);
  assert.ok(prompt.includes('PREVIOUS_SUMMARY'));
  assert.equal(call.model, model);
  assert.equal(call.options.signal, f.event.signal);
  assert.equal(call.options.reasoning, 'high');
  assert.equal(call.options.maxTokens, undefined);
  assert.equal(call.options.cacheRetention, 'none');
  assert.ok(call.options.sessionId);
  assert.equal(result.compaction.firstKeptEntryId, prep.firstKeptEntryId);
  assert.equal(result.compaction.tokensBefore, prep.tokensBefore);
  assert.deepEqual(result.compaction.usage, usage());
  assert.deepEqual(result.compaction.details, {
    readFiles: ['read.txt'], modifiedFiles: ['edit.txt'], pajCaptainCompaction: 1,
  });
  assert.ok(result.compaction.summary.includes('<read-files>\nread.txt\n</read-files>'));
  assert.deepEqual(prep, before);
  assert.deepEqual(f.notices, []);
});

for (const withHistory of [false, true]) {
  test(`real helper focuses split prefix ${withHistory ? 'with' : 'without'} history without a rewrite`, realOptions, async () => {
    const prefix = [{ role: 'user', content: 'SPLIT_PREFIX', timestamp: 0 }];
    const prep = preparation({ isSplitTurn: true, turnPrefixMessages: prefix,
      messagesToSummarize: withHistory ? preparation().messagesToSummarize : [], previousSummary: 'PRIOR' });
    const f = fixture({ prep, customInstructions: 'MANUAL_FOCUS',
      replies: withHistory ? [response({ usage: usage(10, 5) }), response({ usage: usage(20, 7) })]
        : [response({ usage: usage(20, 7) })] });
    const result = await run(f);
    assert.equal(f.calls.length, withHistory ? 2 : 1);
    for (const call of f.calls) {
      assert.deepEqual(call.context.messages.map(message => message.role), ['system', 'user']);
      assert.equal(call.context.systemPrompt, undefined);
      assert.equal(occurrences(JSON.stringify(call.context.messages[1]), 'MANUAL_FOCUS'), 1);
      assert.equal(occurrences(JSON.stringify(call.context.messages[0]), 'MANUAL_FOCUS'), 0);
      const prompt = JSON.stringify(call.context);
      assert.equal(occurrences(prompt, JSON.stringify(CAPTAIN_COMPACTION_GUIDANCE).slice(1, -1)), 1);
      assert.equal(occurrences(prompt, 'MANUAL_FOCUS'), 1);
      assert.equal(call.options.cacheRetention, 'none');
    }
    assert.equal(f.calls.at(-1).options.maxTokens, undefined);
    assert.ok(JSON.stringify(f.calls.at(-1).context).includes('SPLIT_PREFIX'));
    assert.equal(result.compaction.usage.input, withHistory ? 30 : 20);
    assert.equal(result.compaction.usage.output, withHistory ? 12 : 7);
    assert.ok(result.compaction.summary.includes('**Turn Context (split turn):**'));
    assert.equal(result.compaction.firstKeptEntryId, 'keep-me');
    assert.equal(result.compaction.tokensBefore, 12345);
  });
}

test('carryCaptainFiles clones every Set and preserves prior read/modified metadata', () => {
  const prep = preparation({ previousSummary: 'previous' });
  const original = structuredClone(prep);
  const carried = carryCaptainFiles(prep, [ownEntry()]);
  assert.notEqual(carried, prep);
  for (const key of ['read', 'written', 'edited']) assert.notEqual(carried.fileOps[key], prep.fileOps[key]);
  assert.deepEqual([...carried.fileOps.read], ['read.txt', 'old-read']);
  assert.deepEqual([...carried.fileOps.edited], ['edit.txt', 'old-edit']);
  assert.deepEqual(prep, original);
});

test('carryCaptainFiles uses latest branch compaction only and ignores unowned/default metadata', () => {
  const prep = preparation({ previousSummary: 'latest' });
  const older = ownEntry('old', ['abandoned-read'], ['abandoned-edit']);
  const latest = ownEntry('latest', ['latest-read'], ['latest-edit']);
  const result = carryCaptainFiles(prep, [older, latest, { type: 'custom' }]);
  assert.ok(!result.fileOps.read.has('abandoned-read'));
  assert.ok(result.fileOps.read.has('latest-read'));
  for (const entry of [{ ...latest, fromHook: false },
    { ...latest, details: { readFiles: ['foreign'], modifiedFiles: [] } },
    { ...latest, details: { ...latest.details, pajCaptainCompaction: 2 } }]) {
    assert.equal(carryCaptainFiles(prep, [older, entry]), prep);
  }
  assert.equal(carryCaptainFiles(prep, []), prep);
});

test('carryCaptainFiles rejects inconsistent own history and malformed metadata', () => {
  const prep = preparation({ previousSummary: 'previous' });
  assert.throws(() => carryCaptainFiles(prep, [ownEntry('different')]), /history changed/);
  for (const files of [undefined, 'not-an-array', [1], ['valid', null]]) {
    for (const key of ['readFiles', 'modifiedFiles']) {
      const entry = ownEntry();
      entry.details[key] = files;
      assert.throws(() => carryCaptainFiles(prep, [entry]), /metadata/);
    }
  }
});

test('real helper maintains cumulative metadata over three compactions and an off-mode handoff', realOptions, async () => {
  let entries = [];
  for (let index = 0; index < 3; index++) {
    const prep = preparation({ previousSummary: entries.at(-1)?.summary,
      fileOps: { read: new Set([`read-${index}`, 'promoted']), written: new Set(),
        edited: new Set(index === 1 ? ['promoted'] : []) } });
    const f = fixture({ prep, branchEntries: entries });
    const { compaction } = await run(f);
    assert.equal(compaction.details.pajCaptainCompaction, 1);
    assert.deepEqual(compaction.details.readFiles,
      [...Array.from({ length: index + 1 }, (_, n) => `read-${n}`), ...(index === 0 ? ['promoted'] : [])].sort());
    assert.deepEqual(compaction.details.modifiedFiles, index === 0 ? [] : ['promoted']);
    entries.push({ type: 'compaction', fromHook: true, ...compaction });
  }
  const prep = preparation({ previousSummary: entries.at(-1).summary,
    fileOps: { read: new Set(['off-read']), written: new Set(), edited: new Set() } });
  const carried = carryCaptainFiles(prep, entries);
  const f = fixture({ prep: carried });
  const result = await realCompact(carried, model, undefined, undefined, undefined,
    f.event.signal, undefined, f.ctx.modelRegistry.streamSimple.bind(f.ctx.modelRegistry));
  assert.deepEqual(result.details.readFiles, ['off-read', 'read-0', 'read-1', 'read-2']);
  assert.deepEqual(result.details.modifiedFiles, ['promoted']);
  assert.ok(!prep.fileOps.read.has('read-0'));
});

for (const [label, answer] of [
  ['empty text', response({ content: [{ type: 'text', text: '  ' }] })],
  ['no content', response({ content: [] })],
  ['aborted response without signal cancellation', response({ stopReason: 'aborted' })],
  ['tool call', response({ content: [{ type: 'toolCall', id: 'tool', name: 'read', arguments: {} }] })],
  ['length-truncated text', response({ stopReason: 'length' })],
  ['deterministic provider error', response({ stopReason: 'error', errorMessage: 'insufficient_quota billing exhausted' })],
]) {
  test(`real helper fails closed on ${label}, without an unguided retry`, realOptions, async () => {
    const f = fixture({ replies: [answer] });
    assert.deepEqual(await run(f), { cancel: true });
    assert.equal(f.calls.length, 1);
    assert.equal(f.notices.length, 1);
    assert.equal(f.notices[0].level, 'warning');
    assert.match(f.notices[0].message, /No unguided retry/);
  });
}

test('real helper retries transient returned errors with guidance but not a second rewriting pass', realOptions, async () => {
  const f = fixture({ replies: [response({ stopReason: 'error', errorMessage: '503 service unavailable' }), response()] });
  const result = await run(f, { settings: { retry: { enabled: true, maxRetries: 1, baseDelayMs: 0 } } });
  assert.ok(result.compaction);
  assert.equal(f.calls.length, 2);
  assert.deepEqual(f.calls[0].context, f.calls[1].context);
  assert.equal(f.calls[0].options.sessionId, f.calls[1].options.sessionId);
  assert.deepEqual(result.compaction.usage, usage());
});

test('real helper honors disabled retries and an exhausted retry budget', realOptions, async () => {
  for (const retry of [{ enabled: false }, { enabled: true, maxRetries: 0 }]) {
    const f = fixture({ replies: [response({ stopReason: 'error', errorMessage: '503 service unavailable' })] });
    assert.deepEqual(await run(f, { settings: { retry } }), { cancel: true });
    assert.equal(f.calls.length, 1);
  }
});

test('real helper fails closed on thrown streams and rejected result promises', realOptions, async () => {
  for (const synchronous of [true, false]) {
    const f = fixture();
    f.ctx.modelRegistry.streamSimple = () => {
      f.calls.push('called');
      if (synchronous) throw new Error('stream setup failed');
      return { result: () => Promise.reject(new Error('stream result failed')) };
    };
    assert.deepEqual(await run(f), { cancel: true });
    assert.equal(f.calls.length, 1);
  }
});

test('abort before, during, after generation and during retry backoff cancels without warning or retry', realOptions, async () => {
  for (const phase of ['before', 'during', 'after', 'backoff']) {
    const controller = new AbortController();
    const f = fixture({ signal: controller.signal });
    if (phase === 'before') controller.abort();
    if (phase === 'during') {
      f.ctx.modelRegistry.streamSimple = () => {
        f.calls.push('called');
        return { result: async () => { controller.abort(); return response(); } };
      };
    }
    let options = {};
    if (phase === 'after') {
      options.compact = async () => { controller.abort(); return { summary: 'partial' }; };
    }
    if (phase === 'backoff') {
      f.ctx.modelRegistry.streamSimple = () => {
        f.calls.push('called');
        setTimeout(() => controller.abort(), 10);
        return { result: async () => response({ stopReason: 'error', errorMessage: '503 overloaded' }) };
      };
      options.settings = { retry: { enabled: true, maxRetries: 3, baseDelayMs: 10000 } };
    }
    assert.deepEqual(await run(f, options), { cancel: true }, phase);
    assert.equal(f.calls.length, ['before', 'after'].includes(phase) ? 0 : 1, phase);
    assert.deepEqual(f.notices, [], phase);
  }
});

test('stale Captain mode/session before, during or after summarization fails closed', realOptions, async () => {
  for (const phase of ['before', 'during', 'after']) {
    let current = phase !== 'before';
    const f = fixture({ replies: [() => { if (phase === 'during') current = false; return response(); }] });
    const options = { isCurrent: () => current };
    if (phase === 'after') options.compact = async () => {
      current = false;
      return { summary: 'summary', firstKeptEntryId: 'keep-me', tokensBefore: 12345 };
    };
    assert.deepEqual(await run(f, options), { cancel: true });
    assert.equal(f.calls.length, phase === 'during' ? 1 : 0);
    assert.match(f.notices[0].message, /session or mode changed/);
  }
});

test('virtual models and unavailable public APIs cancel before any model call', async () => {
  for (const missing of ['virtual', 'model', 'compact', 'streamSimple']) {
    const f = fixture();
    const options = { compact: async () => { throw new Error('must not call helper'); } };
    if (missing === 'virtual') f.ctx.model = { ...model, api: 'pi-virtual' };
    if (missing === 'model') f.ctx.model = undefined;
    if (missing === 'compact') options.compact = undefined;
    if (missing === 'streamSimple') f.ctx.modelRegistry.streamSimple = undefined;
    assert.deepEqual(await run(f, options), { cancel: true });
    assert.equal(f.calls.length, 0);
    assert.equal(f.notices.length, 1);
    if (missing === 'virtual') assert.match(f.notices[0].message, /virtual-model routing/);
    else assert.match(f.notices[0].message, /unavailable/);
  }
});

test('physical provider adapter preserves public request settings and leaves auth to registry', realOptions, async () => {
  for (const [settings, expected] of [
    [{}, { timeoutMs: 300000, websocketConnectTimeoutMs: 15000, maxRetries: undefined, maxRetryDelayMs: 60000 }],
    [{ httpIdleTimeoutMs: 0 }, { timeoutMs: 2147483647 }],
    [{ websocketConnectTimeoutMs: 'disabled' }, { websocketConnectTimeoutMs: 2147483647 }],
    [{ httpIdleTimeoutMs: 4000, websocketConnectTimeoutMs: 6000,
      retry: { provider: { timeoutMs: 2000, maxRetries: 2, maxRetryDelayMs: 0 } } },
    { timeoutMs: 2000, websocketConnectTimeoutMs: 6000, maxRetries: 2, maxRetryDelayMs: 0 }],
  ]) {
    const f = fixture();
    assert.ok((await run(f, { settings, thinkingLevel: 'low' })).compaction);
    const { options } = f.calls[0];
    for (const [key, value] of Object.entries(expected)) assert.equal(options[key], value, key);
    assert.equal(options.apiKey, undefined);
    assert.equal(options.headers, undefined);
    assert.equal(options.env, undefined);
    assert.equal(options.reasoning, 'low');
  }
});

test('helper receives unchanged prepared inputs, nullish retry defaults and combined native focus', async () => {
  const f = fixture({ customInstructions: 'manual' });
  const received = [];
  const result = await run(f, { thinkingLevel: 'off',
    settings: { retry: { enabled: false, maxRetries: 0, baseDelayMs: 0, maxAgentDelayMs: 0 } },
    compact: async (...args) => {
      received.push(args);
      return { summary: 'summary', firstKeptEntryId: 'keep-me', tokensBefore: 12345,
        usage: usage(), details: { readFiles: [], modifiedFiles: [] } };
    } });
  assert.ok(result.compaction);
  const args = received[0];
  assert.equal(args[0], f.event.preparation);
  assert.equal(args[1], model);
  assert.deepEqual(args.slice(2, 4), [undefined, undefined]);
  assert.equal(args[4], `${CAPTAIN_COMPACTION_GUIDANCE}\n\nUser-supplied compaction focus:\nmanual`);
  assert.equal(args[5], f.event.signal);
  assert.equal(args[6], 'off');
  assert.equal(typeof args[7], 'function');
  assert.deepEqual(args[9], { enabled: false, maxRetries: 0, baseDelayMs: 0, maxAgentDelayMs: 0 });
});

test('reject invalid helper results rather than persist changed retention or token accounting', async () => {
  for (const invalid of [{ summary: '' }, { firstKeptEntryId: 'different' }, { tokensBefore: 0 }]) {
    const f = fixture();
    const compact = async () => ({ summary: 'valid', firstKeptEntryId: 'keep-me', tokensBefore: 12345, ...invalid });
    assert.deepEqual(await run(f, { compact }), { cancel: true });
    assert.match(f.notices[0].message, /Invalid Captain compaction result/);
  }
});

test('real helper delegates output budgeting to the provider and omits unsupported reasoning', realOptions, async () => {
  const f = fixture({ selectedModel: { ...model, maxTokens: 100, reasoning: false } });
  assert.ok((await run(f, { thinkingLevel: 'high' })).compaction);
  assert.equal(f.calls[0].options.maxTokens, undefined);
  assert.equal(f.calls[0].options.reasoning, undefined);
});

test('real helper cannot persist a successful history leg when the split prefix fails', realOptions, async () => {
  const f = fixture({ prep: preparation({ isSplitTurn: true,
    turnPrefixMessages: [{ role: 'user', content: 'prefix', timestamp: 0 }] }),
  replies: [response(), response({ stopReason: 'length' })] });
  assert.deepEqual(await run(f), { cancel: true });
  assert.equal(f.calls.length, 2);
  assert.equal(f.notices.length, 1);
});

test('invalid owned metadata cancels before invoking the helper or provider', async () => {
  const entry = ownEntry();
  entry.details.modifiedFiles = [false];
  const f = fixture({ prep: preparation({ previousSummary: entry.summary }), branchEntries: [entry] });
  let helperCalls = 0;
  assert.deepEqual(await run(f, { compact: async () => { helperCalls++; } }), { cancel: true });
  assert.equal(helperCalls, 0);
  assert.equal(f.calls.length, 0);
  assert.match(f.notices[0].message, /metadata/);
});

test('helper retry policy fills absent public settings with Pi defaults', async () => {
  const f = fixture();
  let policy;
  const compact = async (...args) => {
    policy = args[9];
    return { summary: 'summary', firstKeptEntryId: 'keep-me', tokensBefore: 12345 };
  };
  assert.ok((await run(f, { compact })).compaction);
  assert.deepEqual(policy, { enabled: true, maxRetries: 3, baseDelayMs: 2000, maxAgentDelayMs: 60000 });
});

test('registry adapter forwards helper contexts by identity without injecting focus or mutating messages', async () => {
  for (const content of ['Original prompt', [{ type: 'text', text: 'Original prompt' }]]) {
    const f = fixture({ customInstructions: 'manual' });
    const context = { messages: [
      { role: 'system', content: 'Original system prompt', timestamp: 0 },
      { role: 'user', content, timestamp: 0 },
    ] };
    const before = structuredClone(context);
    const compact = async (prep, selected, key, headers, instructions, signal, thinking, stream) => {
      assert.equal(instructions, `${CAPTAIN_COMPACTION_GUIDANCE}\n\nUser-supplied compaction focus:\nmanual`);
      await stream(selected, context, { signal });
      return { summary: 'summary', firstKeptEntryId: prep.firstKeptEntryId, tokensBefore: prep.tokensBefore };
    };
    assert.ok((await run(f, { compact })).compaction);
    assert.equal(f.calls[0].context, context);
    assert.equal(f.calls[0].context.messages, context.messages);
    assert.deepEqual(context, before);
    assert.equal(occurrences(JSON.stringify(context), CAPTAIN_COMPACTION_GUIDANCE), 0);
  }
});

test('helper receives reviewed native focus when no manual focus is supplied', async () => {
  const f = fixture();
  const compact = async (prep, selected, key, headers, instructions) => {
    assert.equal(instructions, CAPTAIN_COMPACTION_GUIDANCE);
    return { summary: 'summary', firstKeptEntryId: prep.firstKeptEntryId, tokensBefore: prep.tokensBefore };
  };
  assert.ok((await run(f, { compact })).compaction);
});
