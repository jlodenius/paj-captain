import { errorMessage, type LaunchPayload } from './types.ts';
import { accessSync, constants } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { resolveWorkspace } from './workspaces.ts';

export function mainEnvironment(source: NodeJS.ProcessEnv, overrides: NodeJS.ProcessEnv = {}, agentName: string) {
  const env = { ...source };
  for (const key of Object.keys(env)) {
    if (key.startsWith('PAJ_') || key.startsWith('CAPTAIN_') || key.startsWith('PI_CAPTAIN_')) {
      delete env[key];
    }
  }
  for (const key of ['PAJ_RUNTIME_DIR', 'PI_CODING_AGENT_DIR', 'XDG_RUNTIME_DIR', 'PATH', 'HOME']) {
    delete env[key];
    if (typeof overrides[key] === 'string') env[key] = overrides[key];
  }
  env.PAJ_ROLE = 'primary';
  env.PAJ_AGENT_NAME = agentName;
  return env;
}

export function findExecutable(command: string, env = process.env) {
  if (path.isAbsolute(command)) {
    accessSync(command, constants.X_OK);
    return command;
  }
  if (command.includes(path.sep)) throw new Error('Executable must be absolute or a PATH name');
  for (const directory of (env.PATH ?? '').split(path.delimiter).filter(path.isAbsolute)) {
    const candidate = path.join(directory, command);
    try { accessSync(candidate, constants.X_OK); return candidate; } catch {}
  }
  throw new Error(`Executable not found: ${command}`);
}

export function runMain(payload: LaunchPayload, { env = process.env, exec = process.execve }: {
  env?: NodeJS.ProcessEnv; exec?: typeof process.execve;
} = {}) {
  if (!payload || !path.isAbsolute(payload.piExecutable) || !payload.agentName) {
    throw new Error('Invalid main-agent launch payload');
  }
  const workspace = resolveWorkspace(payload.workspace, payload.policy, { home: payload.home });
  if (workspace !== payload.workspace) throw new Error('Workspace changed before Pi startup');
  const args = [payload.piExecutable, '--name', payload.agentName];
  if (payload.model) args.push('--model', payload.model);
  const childEnv = mainEnvironment(env, payload.environment, payload.agentName);
  process.chdir(workspace);
  if (!exec) throw new Error('Node.js execve is unavailable; use Node.js 24 or newer');
  const definedEnv = Object.fromEntries(Object.entries(childEnv)
    .filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
  exec(payload.piExecutable, args, definedEnv);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    if (process.argv.length !== 3) throw new Error('Expected one encoded launch payload');
    runMain(JSON.parse(Buffer.from(process.argv[2], 'base64url').toString('utf8')));
  } catch (error) {
    process.stderr.write(`Captain main-agent startup failed: ${errorMessage(error)}\n`);
    process.exitCode = 1;
  }
}
