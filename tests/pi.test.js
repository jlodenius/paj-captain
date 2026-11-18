import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const rootPackage = fileURLToPath(new URL('../', import.meta.url));
const pajExtension = process.env.PAJ_CAPTAIN_PAJ_EXTENSION;

function rpc(t, root, withPaj) {
  const agent = join(root, 'a');
  const extensions = join(agent, 'extensions');
  mkdirSync(extensions, { recursive: true });
  mkdirSync(join(root, 'r'), { mode: 0o700 });
  symlinkSync(rootPackage, join(extensions, 'paj-captain'));
  if (withPaj) symlinkSync(pajExtension, join(extensions, 'paj'));
  writeFileSync(join(extensions, 'inspect.ts'), `export default function(pi) {
    pi.registerCommand('captain-inspect', { description: 'Test inspection', handler: async (_args,ctx) => {
      ctx.ui.notify(JSON.stringify({active:pi.getActiveTools(),all:pi.getAllTools(),
        branch:ctx.sessionManager.getBranch().filter(e=>e.type==='custom')}),'info');
    }});
    pi.registerCommand('captain-test-reload', { description: 'Test reload', handler: async (_args,ctx) => {
      await ctx.reload();
    }});
  }`);
  writeFileSync(join(agent, 'settings.json'), JSON.stringify({ defaultProjectTrust: 'always', cacheWarming: 'off' }));
  const env = Object.fromEntries(Object.entries(process.env)
    .filter(([key]) => !/API_KEY|TOKEN|SECRET|CREDENTIAL|^PAJ_|^CAPTAIN_|^PI_CAPTAIN_/.test(key)));
  Object.assign(env, { HOME: root, PI_CODING_AGENT_DIR: agent, XDG_RUNTIME_DIR: join(root, 'r'),
    PAJ_RUNTIME_DIR: join(root, 'p'), XDG_CONFIG_HOME: join(root, 'c') });
  const child = spawn(process.env.PAJ_CAPTAIN_PI_BIN, ['--mode', 'rpc', '--no-session'], {
    cwd: root, env, stdio: ['pipe', 'pipe', 'pipe'],
  });
  const pending = new Map();
  const events = [];
  let buffer = '';
  let errors = '';
  let next = 0;
  child.stderr.on('data', chunk => { errors += chunk; });
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', chunk => {
    buffer += chunk;
    let index;
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      if (!line.startsWith('{')) continue;
      const record = JSON.parse(line);
      events.push(record);
      if (record.type === 'agent_start') child.kill('SIGTERM');
      if (record.type === 'response' && pending.has(record.id)) {
        pending.get(record.id).resolve(record);
        pending.delete(record.id);
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
    rmSync(root, { recursive: true, force: true });
    assert.ok(!events.some(event => event.type === 'agent_start'), 'Commands must not invoke a model');
  });
  async function request(type, extra = {}) {
    const id = `request-${++next}`;
    const response = new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
    child.stdin.write(`${JSON.stringify({ id, type, ...extra })}\n`);
    const result = await response;
    assert.equal(result.success, true, result.error || errors);
    return result.data;
  }
  async function command(message) {
    const start = events.length;
    const response = await request('prompt', { message });
    assert.equal(response.disposition, 'handled');
    return events.slice(start).filter(event => event.method === 'notify');
  }
  return { request, command, events };
}

test('real Pi discovers the whole-package link and /captain fails closed without Paj',
  { skip: !process.env.PAJ_CAPTAIN_PI_BIN, timeout: 30000 }, async t => {
  const root = mkdtempSync(join(tmpdir(), 'cpt-'));
  const connection = rpc(t, root, false);
  const commands = await connection.request('get_commands');
  assert.ok(commands.commands.some(command => command.name === 'captain'));
  const before = JSON.parse((await connection.command('/captain-inspect')).at(-1).message);
  assert.ok(!before.active.includes('captain_delegate'));
  assert.equal(before.all.find(tool => tool.name === 'captain_delegate').exposure, 'hidden');
  const activation = await connection.command('/captain');
  assert.ok(activation.some(event => event.notifyType === 'error'));
  const after = JSON.parse((await connection.command('/captain-inspect')).at(-1).message);
  assert.ok(!after.active.includes('captain_delegate'));
});

test('real Pi and Paj support /captain activation, hidden/direct tools, OFF after reload and disabling',
  { skip: !process.env.PAJ_CAPTAIN_PI_BIN || !pajExtension, timeout: 30000 }, async t => {
  const root = mkdtempSync(join(tmpdir(), 'cpt-'));
  const connection = rpc(t, root, true);
  const commands = await connection.request('get_commands');
  assert.ok(commands.commands.some(command => command.name === 'captain'));
  assert.ok(commands.commands.some(command => command.name === 'agent-name'));
  const activation = await connection.command('/captain');
  assert.ok(activation.some(event => event.message.startsWith('Captain enabled')), JSON.stringify(activation));
  const active = JSON.parse((await connection.command('/captain-inspect')).at(-1).message);
  assert.ok(active.active.includes('captain_delegate'));
  assert.ok(!active.active.includes('spawn_sub_agent'));
  assert.equal(active.all.find(tool => tool.name === 'captain_delegate').exposure, 'direct');
  assert.ok(active.branch.some(entry => entry.customType === 'paj-captain-mode' && entry.data.enabled));
  await connection.command('/captain-test-reload');
  const reloaded = JSON.parse((await connection.command('/captain-inspect')).at(-1).message);
  assert.ok(!reloaded.active.includes('captain_delegate'));
  await connection.command('/captain');
  await connection.command('/captain off');
  const inactive = JSON.parse((await connection.command('/captain-inspect')).at(-1).message);
  assert.ok(!inactive.active.includes('captain_delegate'));
  assert.ok(inactive.active.includes('spawn_sub_agent'));
  assert.equal(inactive.all.find(tool => tool.name === 'captain_delegate').exposure, 'hidden');
  await connection.command('/captain');
  assert.equal((await connection.request('new_session')).cancelled, false);
  const fresh = JSON.parse((await connection.command('/captain-inspect')).at(-1).message);
  assert.ok(!fresh.active.includes('captain_delegate'));
});
