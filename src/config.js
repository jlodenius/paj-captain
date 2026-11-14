import { mkdirSync, readFileSync, lstatSync, statSync, openSync, writeFileSync, fsyncSync, closeSync,
  renameSync, unlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve, isAbsolute, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

export const DEFAULT_CONFIG = Object.freeze({ version: 1,
  workspaces: Object.freeze({ allow: Object.freeze([]), exclude: Object.freeze([]) }),
  reporting: Object.freeze({ progress: false, verbosity: 'brief' }) });

export function captainPaths(env = process.env, home = homedir()) {
  const configured = env.PI_CODING_AGENT_DIR || join(home, '.pi', 'agent');
  const agentDir = configured === '~' ? home : configured.startsWith('~/')
    ? join(home, configured.slice(2)) : resolve(configured);
  return { agentDir, configFile: join(agentDir, 'captain.json'),
    stateDir: join(agentDir, 'captain', 'sessions') };
}

function object(value, keys, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some(key => !keys.includes(key))) {
    throw new Error(`Invalid ${label} configuration`);
  }
}

function patterns(value, label) {
  if (!Array.isArray(value) || value.length > 64 || value.some(item => typeof item !== 'string'
    || !item || item.length > 4096 || /[\x00-\x1f\x7f]/.test(item)
    || (!isAbsolute(item) && !item.startsWith('~/')))) {
    throw new Error(`${label} must contain absolute or ~/ workspace patterns`);
  }
  if (value.some(item => /[?\[\]{}]/.test(item))) {
    throw new Error('Only * and ** workspace globs are supported');
  }
  return [...new Set(value)];
}

export function validateConfig(value) {
  object(value, ['version', 'workspaces', 'reporting'], 'Captain');
  if (value.version !== undefined && value.version !== 1) throw new Error('Unsupported Captain config version');
  const workspaces = value.workspaces ?? DEFAULT_CONFIG.workspaces;
  const reporting = value.reporting ?? DEFAULT_CONFIG.reporting;
  object(workspaces, ['allow', 'exclude'], 'workspace');
  object(reporting, ['progress', 'verbosity'], 'reporting');
  const progress = reporting.progress ?? false;
  const verbosity = reporting.verbosity ?? 'brief';
  if (typeof progress !== 'boolean' || !['brief', 'detailed'].includes(verbosity)) {
    throw new Error('Invalid reporting preferences');
  }
  return { version: 1, workspaces: { allow: patterns(workspaces.allow ?? [], 'allow'),
    exclude: patterns(workspaces.exclude ?? [], 'exclude') }, reporting: { progress, verbosity } };
}

export function loadConfig(file) {
  try {
    const stat = statSync(file);
    if (!stat.isFile()) throw new Error('Captain configuration must be a regular file');
    if (stat.size > 65536) throw new Error('Captain configuration is too large');
    const raw = readFileSync(file, 'utf8');
    if (Buffer.byteLength(raw) > 65536) throw new Error('Captain configuration is too large');
    return validateConfig(JSON.parse(raw));
  } catch (error) {
    if (error.code === 'ENOENT') return validateConfig({});
    throw error;
  }
}

export function saveConfig(file, value) {
  const config = validateConfig(value);
  const data = `${JSON.stringify(config, null, 2)}\n`;
  if (Buffer.byteLength(data) > 65536) throw new Error('Captain configuration is too large');
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  try {
    if (!lstatSync(file).isFile()) throw new Error('Edit your declarative Captain config at its source');
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const temporary = join(dirname(file), `.captain-${randomUUID()}.json`);
  let fd;
  try {
    fd = openSync(temporary, 'wx', 0o600);
    writeFileSync(fd, data);
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(temporary, file);
    const directory = openSync(dirname(file), 'r');
    try { fsyncSync(directory); } finally { closeSync(directory); }
  } finally {
    if (fd !== undefined) closeSync(fd);
    try { unlinkSync(temporary); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  return config;
}
