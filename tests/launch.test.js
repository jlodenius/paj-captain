import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync, symlinkSync, existsSync,
} from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { execFile, spawnSync } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { launchMain } from '../src/launch.ts';
import { mainEnvironment, runMain } from '../src/run-main.ts';

const execute = promisify(execFile);
const launchModule = fileURLToPath(new URL('../src/launch.ts', import.meta.url));

function fixture(t, { cleanup = true } = {}) {
  const home = mkdtempSync(path.join(tmpdir(), 'captain-launch-'));
  if (cleanup) t.after(() => rmSync(home, { recursive: true, force: true }));
  const workspace = path.join(home, 'projects', '$(touch NEVER); "quoted"\nproject');
  mkdirSync(workspace, { recursive: true });
  const policy = { allow: [path.join(home, 'projects', '**')], exclude: [] };
  const calls = [];
  const run = async (command, args, options) => {
    calls.push({ command, args, options });
    return { stdout: `${args[args.indexOf('-s') + 1]}\n` };
  };
  const env = {
    PATH: process.env.PATH, HOME: home, PI_CODING_AGENT_DIR: path.join(home, 'agent'),
    PAJ_RUNTIME_DIR: path.join(home, 'runtime'), PAJ_PROJECT_DIRS: 'projects',
    XDG_RUNTIME_DIR: path.join(home, 'xdg-runtime'),
    PAJ_ROLE: 'subagent', PAJ_PARENT_PI_SESSION_ID: 'parent', PAJ_TASK_ID: 'task',
    PAJ_TASK: 'task text', PAJ_SPAWN_ID: 'spawn', PAJ_PI_SESSION_ID: 'child',
    PAJ_PI_SESSION_PID: '11', PAJ_AGENT_NAME: 'old-name', PAJ_SESSION_ID: 'old',
    CAPTAIN_ACTIVE: '1', PI_CAPTAIN_ACTIVE: '1', TMUX: 'private-paj-socket', TMUX_PANE: '%0',
  };
  return { home, workspace, policy, calls, options: { env, home, run, piExecutable: process.execPath } };
}

function decode(call) {
  return JSON.parse(Buffer.from(call.args.at(-1), 'base64url').toString('utf8'));
}

test('launch uses direct argv, absolute helper, exact default tmux, and main identity', async t => {
  const { workspace, policy, calls, options } = fixture(t);
  const result = await launchMain({ workspace, name: 'worker', model: 'provider/model:high', requestId: 'one' }, policy, options);
  assert.equal(calls.length, 1);
  const call = calls[0];
  assert.equal(call.command, 'tmux');
  assert.deepEqual(call.args.slice(0, 4), ['-L', 'default', 'new-session', '-d']);
  assert.equal(call.args[call.args.indexOf('-c') + 1], workspace);
  assert.equal(call.args.at(-3), process.execPath);
  assert.equal(path.isAbsolute(call.args.at(-2)), true);
  assert.match(call.args.at(-2), /run-main\.ts$/);
  assert.equal(call.options.cwd, workspace);
  assert.equal(call.options.timeout, 15000);
  assert.equal(call.options.env.TMUX, undefined);
  assert.equal(call.options.env.CAPTAIN_ACTIVE, undefined);
  assert.equal(call.options.env.PI_CAPTAIN_ACTIVE, undefined);
  assert.deepEqual(Object.keys(call.options.env).filter(key => key.startsWith('PAJ_')).sort(),
    ['PAJ_AGENT_NAME', 'PAJ_PROJECT_DIRS', 'PAJ_ROLE', 'PAJ_RUNTIME_DIR']);
  assert.equal(call.options.env.PAJ_ROLE, 'primary');
  assert.equal(call.options.env.PAJ_AGENT_NAME, result.agentName);
  assert.equal(call.options.env.PI_CODING_AGENT_DIR, options.env.PI_CODING_AGENT_DIR);
  assert.equal(decode(call).model, 'provider/model:high');
  assert.equal(decode(call).workspace, workspace);
  assert.equal(result.status, 'launched');
  assert.match(result.tmuxSession, /^captain-worker-[a-f0-9]{16}$/);
  assert.match(result.attachCommand, new RegExp(`-L default attach-session -t =${result.tmuxSession}$`));
  assert.match(result.agentName, /^worker-[a-f0-9]{16}$/);
});

test('relative and tilde agent directories use the same absolute config and receipt location', async t => {
  for (const tilde of [false, true]) {
    const { home, workspace, policy, calls, options } = fixture(t);
    const expected = path.join(home, 'configured-agent');
    options.env.PI_CODING_AGENT_DIR = tilde ? '~/configured-agent' : path.relative(process.cwd(), expected);
    await launchMain({ workspace, requestId: tilde ? 'tilde' : 'relative' }, policy, options);
    assert.equal(decode(calls[0]).environment.PI_CODING_AGENT_DIR, expected);
    assert.equal(calls[0].options.env.PI_CODING_AGENT_DIR, expected);
    assert.ok(existsSync(path.join(expected, 'captain', 'launches')));
  }
});

test('request receipts are durable, deterministic, idempotent, and reject conflicting reuse', async t => {
  const { workspace, policy, calls, options } = fixture(t);
  const input = { workspace, requestId: 'same' };
  const first = await launchMain(input, policy, options);
  assert.deepEqual(await launchMain(input, policy, { ...options }), first);
  assert.equal(calls.length, 1);
  await assert.rejects(launchMain({ ...input, model: 'different/model' }, policy, options), /different input/);
  const second = await launchMain({ ...input, requestId: 'different' }, policy, options);
  assert.notEqual(second.tmuxSession, first.tmuxSession);
  assert.notEqual(second.agentName, first.agentName);
  assert.equal(decode(calls[0]).model, undefined);
});

test('uncertain failures and unconfirmed exact names never retry', async t => {
  const { workspace, policy, options } = fixture(t);
  let count = 0;
  const run = async () => { count++; throw new Error('timeout after server may have accepted'); };
  const input = { workspace, requestId: 'uncertain' };
  await assert.rejects(launchMain(input, policy, { ...options, run }), /outcome uncertain/);
  await assert.rejects(launchMain(input, policy, { ...options, run }), /do not retry/);
  assert.equal(count, 1);
  await assert.rejects(launchMain({ workspace, requestId: 'wrong-name' }, policy, {
    ...options, run: async () => ({ stdout: 'wrong-name\n' }),
  }), /exact session name/);
});

test('restart with a prepared receipt is uncertain and does not retry', async t => {
  const { workspace, policy, options, calls } = fixture(t);
  const input = { workspace, requestId: 'interrupted' };
  await launchMain(input, policy, options);
  const { createHash } = await import('node:crypto');
  const digest = createHash('sha256').update(input.requestId).digest('hex');
  const file = path.join(options.env.PI_CODING_AGENT_DIR, 'captain', 'launches', `${digest}.json`);
  const receipt = JSON.parse(readFileSync(file, 'utf8'));
  writeFileSync(file, JSON.stringify({ ...receipt, state: 'prepared' }));
  await assert.rejects(launchMain(input, policy, options), /uncertain/);
  assert.equal(calls.length, 1);
});

test('workspace is rechecked immediately before tmux creation', async t => {
  const { home, workspace, policy, options, calls } = fixture(t);
  const outside = path.join(home, 'outside');
  mkdirSync(outside);
  const changedOptions = { ...options };
  Object.defineProperty(changedOptions, 'piExecutable', { get() {
    rmSync(workspace, { recursive: true });
    symlinkSync(outside, workspace);
    return process.execPath;
  } });
  await assert.rejects(launchMain({ workspace, requestId: 'swapped' }, policy, changedOptions), /not allowed/);
  assert.equal(calls.length, 0);
});

test('concurrent duplicate requests invoke tmux at most once', async t => {
  const { workspace, policy, options, calls } = fixture(t);
  const input = { workspace, requestId: 'concurrent' };
  const results = await Promise.allSettled([launchMain(input, policy, options), launchMain(input, policy, options)]);
  assert.equal(calls.length, 1);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.match(results.find(result => result.status === 'rejected').reason.message, /uncertain/);
});

test('rejects malicious names/models without execution; request IDs are hashed and paths stay literal', async t => {
  const { home, workspace, policy, options, calls } = fixture(t);
  for (const name of ['bad;touch PWNED', '--option', '$(id)', 'a\nb', '../escape']) {
    await assert.rejects(launchMain({ workspace, requestId: 'name', name }, policy, options), /name/);
  }
  for (const model of ['--print', 'x;touch PWNED', '$(id)', 'x\ny', 'x y', '']) {
    await assert.rejects(launchMain({ workspace, requestId: 'model', model }, policy, options), /model/);
  }
  assert.equal(calls.length, 0);
  await launchMain({ workspace, requestId: '../../; $(touch PWNED)' }, policy, options);
  assert.equal(existsSync(path.join(home, 'PWNED')), false);
  assert.equal(calls.length, 1);
});

test('symlink state paths and corrupted receipts fail closed', async t => {
  const { home, workspace, policy, options } = fixture(t);
  const directory = path.join(home, 'real-state');
  mkdirSync(directory);
  const link = path.join(home, 'state-link');
  symlinkSync(directory, link);
  await assert.rejects(launchMain({ workspace, requestId: 'link' }, policy, { ...options, stateDir: link }), /Unsafe/);
  const { createHash } = await import('node:crypto');
  const hash = createHash('sha256').update('corrupt').digest('hex');
  writeFileSync(path.join(directory, `${hash}.json`), '{');
  await assert.rejects(launchMain({ workspace, requestId: 'corrupt' }, policy, { ...options, stateDir: directory }));
});

test('helper scrubs stale server identity, preserves overrides, and starts interactive Pi argv', t => {
  const { workspace, policy, options } = fixture(t);
  const previous = process.cwd();
  t.after(() => process.chdir(previous));
  const payload = {
    workspace, policy, home: options.home, piExecutable: process.execPath,
    agentName: 'worker-unique', model: 'provider/model:high',
    environment: options.env,
  };
  let invocation;
  runMain(payload, { env: { ...options.env, PAJ_SECRET_UNKNOWN: 'stale', PI_CODING_AGENT_DIR: 'wrong' },
    exec: (...args) => { invocation = args; } });
  assert.deepEqual(invocation.slice(0, 2), [process.execPath,
    [process.execPath, '--name', 'worker-unique', '--model', 'provider/model:high']]);
  assert.equal(invocation[2].PAJ_SECRET_UNKNOWN, undefined);
  assert.equal(invocation[2].PAJ_PARENT_PI_SESSION_ID, undefined);
  assert.equal(invocation[2].PI_CODING_AGENT_DIR, options.env.PI_CODING_AGENT_DIR);
  assert.equal(invocation[2].PAJ_RUNTIME_DIR, options.env.PAJ_RUNTIME_DIR);
  assert.equal(invocation[2].XDG_RUNTIME_DIR, options.env.XDG_RUNTIME_DIR);
  assert.equal(invocation[2].PAJ_ROLE, 'primary');
  assert.equal(process.cwd(), workspace);
  assert.equal(mainEnvironment({ PAJ_TASK: 'stale', PAJ_RUNTIME_DIR: 'old' }, {}, 'worker').PAJ_RUNTIME_DIR, undefined);
});

test('helper rechecks canonical policy after directory replacement', t => {
  const { workspace, policy, options, home } = fixture(t);
  rmSync(workspace, { recursive: true });
  const outside = path.join(home, 'outside');
  mkdirSync(outside);
  symlinkSync(outside, workspace);
  assert.throws(() => runMain({ workspace, policy, home, agentName: 'worker', piExecutable: process.execPath }, {
    env: options.env, exec: () => assert.fail('must not execute'),
  }), /not allowed/);
});

test('isolated real default tmux starts literal argv and survives launching process exit', {
  skip: spawnSync('tmux', ['-V']).status !== 0,
}, async t => {
  const { home, workspace, policy, options } = fixture(t, { cleanup: false });
  const socketDir = path.join(home, 'sockets');
  mkdirSync(socketDir, { mode: 0o700 });
  const env = { ...process.env, ...options.env, TMUX_TMPDIR: socketDir };
  delete env.TMUX;
  delete env.TMUX_PANE;
  const tmux = args => execute('tmux', ['-L', 'default', ...args], { env });
  t.after(async () => {
    try { await tmux(['kill-server']); } catch {}
    rmSync(home, { recursive: true, force: true });
  });
  await tmux(['-f', '/dev/null', 'new-session', '-d', '-s', 'stale-server-environment', process.execPath, '-e', 'setInterval(() => {}, 1000)']);
  const output = path.join(home, 'worker.json');
  const fakePi = path.join(home, 'fake-pi');
  writeFileSync(fakePi, `#!${process.execPath}\n` +
    `require('node:fs').writeFileSync(${JSON.stringify(output)}, JSON.stringify({argv:process.argv,env:process.env,pid:process.pid,cwd:process.cwd()}));\n` +
    'setInterval(() => {}, 1000);\n', { mode: 0o700 });
  const childOptions = { env, home, piExecutable: fakePi };
  const script = `import {launchMain} from ${JSON.stringify(launchModule)};` +
    `console.log(JSON.stringify(await launchMain(${JSON.stringify({ workspace, name: 'real', requestId: 'survive', model: 'provider/model:high' })},` +
    `${JSON.stringify(policy)},${JSON.stringify(childOptions)})));`;
  const { stdout } = await execute(process.execPath, ['--input-type=module', '-e', script], { env });
  const result = JSON.parse(stdout);
  for (let i = 0; i < 100 && !existsSync(output); i++) await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(existsSync(output), true, 'fake Pi started after launching process exited');
  const worker = JSON.parse(readFileSync(output, 'utf8'));
  assert.equal(worker.cwd, workspace);
  assert.deepEqual(worker.argv.slice(2), ['--name', result.agentName, '--model', 'provider/model:high']);
  assert.equal(worker.env.PAJ_ROLE, 'primary');
  assert.equal(worker.env.PAJ_PARENT_PI_SESSION_ID, undefined);
  assert.equal(worker.env.PAJ_PI_SESSION_ID, undefined);
  assert.equal(worker.env.PAJ_TASK_ID, undefined);
  assert.equal(worker.env.PI_CODING_AGENT_DIR, env.PI_CODING_AGENT_DIR);
  assert.equal(worker.env.PAJ_RUNTIME_DIR, env.PAJ_RUNTIME_DIR);
  assert.equal(worker.env.XDG_RUNTIME_DIR, env.XDG_RUNTIME_DIR);
  assert.equal(worker.env.CAPTAIN_ACTIVE, undefined);
  await tmux(['has-session', '-t', `=${result.tmuxSession}`]);
  const live = await tmux(['list-sessions', '-F', '#{session_name}']);
  assert.equal(live.stdout.trim().split('\n').includes(result.tmuxSession), true);
  process.kill(worker.pid, 0);
});
