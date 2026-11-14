import { homedir } from 'node:os';
import path from 'node:path';
import { realpathSync, statSync, opendirSync } from 'node:fs';

const skipped = new Set(['.git', 'node_modules', '.direnv', '.cache']);

function expand(value, home, base, pattern = false) {
  if (typeof value !== 'string' || !value || value.includes('\0')) {
    throw new Error('Workspace paths must be nonempty strings without NUL');
  }
  if (value === '~' || value.startsWith('~/')) value = path.join(home, value.slice(2));
  else if (value.startsWith('~')) throw new Error('Only ~/ home expansion is supported');
  if (pattern && !path.isAbsolute(value)) throw new Error('Policy patterns must be absolute or ~/');
  if (pattern && /[?\[\]{}]/.test(value)) throw new Error('Only * and ** policy globs are supported');
  return path.resolve(base, value);
}

function canonicalPrefix(value) {
  const tail = [];
  let current = value;
  for (;;) {
    try {
      return path.join(realpathSync(current), ...tail);
    } catch (error) {
      if (!['ENOENT', 'ENOTDIR'].includes(error.code)) throw error;
      const parent = path.dirname(current);
      if (parent === current) throw error;
      tail.unshift(path.basename(current));
      current = parent;
    }
  }
}

function compile(pattern, home) {
  const absolute = expand(pattern, home, home, true);
  const parts = absolute.split(path.sep).filter(Boolean);
  const firstGlob = parts.findIndex(part => part.includes('*'));
  if (firstGlob < 0) {
    const root = canonicalPrefix(absolute);
    return { root, parts: root.split(path.sep).filter(Boolean) };
  }
  const root = canonicalPrefix(path.join(path.parse(absolute).root, ...parts.slice(0, firstGlob)));
  return { root, parts: [...root.split(path.sep).filter(Boolean), ...parts.slice(firstGlob)] };
}

function componentMatch(pattern, value) {
  const escaped = pattern.split('*').map(part => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  return new RegExp(`^${escaped.join('.*')}$`, 'su').test(value);
}

function matches(pattern, target) {
  const parts = target.split(path.sep).filter(Boolean);
  const memo = new Map();
  const visit = (i, j) => {
    const key = `${i}:${j}`;
    if (memo.has(key)) return memo.get(key);
    let result;
    if (i === pattern.length) result = j === parts.length;
    else if (pattern[i] === '**') {
      result = visit(i + 1, j) || (j < parts.length && visit(i, j + 1));
    } else result = j < parts.length && componentMatch(pattern[i], parts[j]) && visit(i + 1, j + 1);
    memo.set(key, result);
    return result;
  };
  return visit(0, 0);
}

function compilePolicy(policy, home) {
  if (!policy || !Array.isArray(policy.allow) || !Array.isArray(policy.exclude)) {
    throw new Error('Workspace policy requires allow and exclude arrays');
  }
  return {
    allow: policy.allow.map(pattern => compile(pattern, home)),
    exclude: policy.exclude.map(pattern => compile(pattern, home)),
  };
}

function permitted(target, policy) {
  return policy.allow.some(pattern => matches(pattern.parts, target)) &&
    !policy.exclude.some(pattern => matches(pattern.parts, target));
}

export function resolveWorkspace(input, policy, { home = homedir(), base = process.cwd() } = {}) {
  const compiled = compilePolicy(policy, home);
  const target = realpathSync(expand(input, home, base));
  if (!statSync(target).isDirectory()) throw new Error('Workspace must be an existing directory');
  if (!permitted(target, compiled)) throw new Error(`Workspace is not allowed: ${target}`);
  return target;
}

export function listWorkspaces(policy, { home = homedir(), limit = 100 } = {}) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 1000) {
    throw new Error('Workspace listing limit must be an integer from 1 to 1000');
  }
  const compiled = compilePolicy(policy, home);
  const found = new Set();
  const seen = new Set();
  const queue = [...new Set(compiled.allow.map(pattern => pattern.root))].sort()
    .map(directory => ({ directory, depth: 0 }));
  let position = 0;
  let budget = 20000;
  let truncated = false;
  while (position < queue.length) {
    if (--budget < 0) { truncated = true; break; }
    const { directory, depth } = queue[position++];
    if (seen.has(directory)) continue;
    seen.add(directory);
    let canonical;
    try {
      canonical = realpathSync(directory);
      if (canonical !== directory || !statSync(directory).isDirectory()) continue;
    } catch (error) {
      if (['ENOENT', 'ENOTDIR', 'EACCES'].includes(error.code)) continue;
      throw error;
    }
    if (permitted(canonical, compiled)) {
      found.add(canonical);
      if (found.size > limit) { truncated = true; break; }
    }
    if (depth >= 128) { truncated = true; continue; }
    const children = [];
    let handle;
    try {
      handle = opendirSync(directory);
      for (;;) {
        const entry = handle.readSync();
        if (!entry) break;
        if (--budget < 0) { truncated = true; break; }
        if (entry.isDirectory() && !skipped.has(entry.name)) {
          children.push({ directory: path.join(directory, entry.name), depth: depth + 1 });
        }
      }
    } catch (error) {
      if (!['ENOENT', 'ENOTDIR', 'EACCES'].includes(error.code)) throw error;
    } finally {
      handle?.closeSync();
    }
    queue.push(...children.sort((a, b) => a.directory.localeCompare(b.directory)));
  }
  return { workspaces: [...found].slice(0, limit).sort(), truncated };
}
