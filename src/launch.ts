import { errorCode, errorMessage, type LaunchRequest, type WorkspacePolicy, type RunCommand } from './types.ts';

interface LaunchResult {
  tmuxSession: string; agentName: string; workspace: string; status: 'launched'; attachCommand: string;
}
interface LaunchReceipt {
  version: 1;
  state: 'prepared' | 'launched' | 'delivery_unknown';
  fingerprint: string;
  result: LaunchResult;
}
interface LaunchOptions {
  env?: NodeJS.ProcessEnv; home?: string; base?: string; stateDir?: string;
  nodeExecutable?: string; piExecutable?: string; run?: RunCommand;
}
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash, randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  mkdirSync, lstatSync, openSync, closeSync, writeFileSync, readFileSync,
  fsyncSync, renameSync, constants,
} from 'node:fs';
import { resolveWorkspace } from './workspaces.ts';
import { findExecutable, mainEnvironment } from './run-main.ts';
import { captainPaths } from './config.ts';

const execute = promisify(execFile);
const helper = fileURLToPath(new URL(import.meta.url.endsWith('.ts')
  ? './run-main.ts' : './run-main.js', import.meta.url));

function secureDirectory(directory: string) {
  const absolute = path.resolve(directory);
  let current = path.parse(absolute).root;
  for (const part of absolute.slice(current.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    try { mkdirSync(current, { mode: 0o700 }); } catch (error) {
      if (errorCode(error) !== 'EEXIST') throw error;
    }
    const stat = lstatSync(current);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error('Unsafe launch state directory');
  }
  return absolute;
}

function readReceipt(file: string): LaunchReceipt {
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const text = readFileSync(fd, 'utf8');
    if (text.length > 32768) throw new Error('Invalid launch receipt');
    const receipt = JSON.parse(text);
    if (receipt.version !== 1 || !receipt.fingerprint || !receipt.result ||
        !['prepared', 'launched', 'delivery_unknown'].includes(receipt.state)) {
      throw new Error('Invalid launch receipt');
    }
    return receipt;
  } finally { closeSync(fd); }
}

function writeReceipt(file: string, receipt: LaunchReceipt, exclusive = false) {
  const destination = exclusive ? file : `${file}.${randomUUID()}.tmp`;
  const fd = openSync(destination,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    writeFileSync(fd, JSON.stringify(receipt));
    fsyncSync(fd);
  } finally { closeSync(fd); }
  if (!exclusive) renameSync(destination, file);
  const directory = openSync(path.dirname(file), constants.O_RDONLY | constants.O_DIRECTORY);
  try { fsyncSync(directory); } finally { closeSync(directory); }
}

export async function launchMain({ workspace, name, model, requestId }: LaunchRequest,
  policy: WorkspacePolicy, options: LaunchOptions = {}): Promise<LaunchResult> {
  if (typeof requestId !== 'string' || !requestId.trim() || requestId.length > 512 ||
      requestId.includes('\0')) throw new Error('A nonempty launch requestId is required');
  if (name !== undefined && (typeof name !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,47}$/.test(name))) {
    throw new Error('Agent name must contain only letters, digits, underscores and hyphens');
  }
  if (model !== undefined && (typeof model !== 'string' ||
      !/^[A-Za-z0-9][A-Za-z0-9._:/+@-]{0,255}$/.test(model))) {
    throw new Error('Invalid provider/model identifier');
  }
  const sourceEnv = options.env ?? process.env;
  const home = options.home ?? sourceEnv.HOME ?? homedir();
  const canonical = resolveWorkspace(workspace, policy, { home, base: options.base });
  const digest = createHash('sha256').update(requestId).digest('hex');
  const label = (name ?? path.basename(canonical)).normalize('NFKD')
    .replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24) || 'main';
  const tmuxSession = `captain-${label}-${digest.slice(0, 16)}`;
  const agentName = `${label}-${digest.slice(0, 16)}`;
  const result: LaunchResult = {
    tmuxSession, agentName, workspace: canonical, status: 'launched',
    attachCommand: `TMUX= tmux -L default attach-session -t =${tmuxSession}`,
  };
  const fingerprint = createHash('sha256')
    .update(JSON.stringify({ workspace: canonical, name: name ?? null, model: model ?? null }))
    .digest('hex');
  const agentDir = captainPaths(sourceEnv, home).agentDir;
  const stateDir = secureDirectory(options.stateDir ?? path.join(agentDir, 'captain', 'launches'));
  const receiptFile = path.join(stateDir, `${digest}.json`);
  const repeat = () => {
    const existing = readReceipt(receiptFile);
    if (existing.fingerprint !== fingerprint) throw new Error('Launch requestId already used with different input');
    if (existing.state !== 'launched') throw new Error('Launch outcome is uncertain; inspect tmux, do not retry');
    if (JSON.stringify(existing.result) !== JSON.stringify(result)) throw new Error('Invalid launch receipt result');
    return result;
  };
  try { lstatSync(receiptFile); return repeat(); } catch (error) {
    if (errorCode(error) !== 'ENOENT') throw error;
  }
  const nodeExecutable = options.nodeExecutable ?? process.execPath;
  if (!path.isAbsolute(nodeExecutable)) throw new Error('Node executable must be absolute');
  const piExecutable = findExecutable(options.piExecutable ?? 'pi', sourceEnv);
  const environment: NodeJS.ProcessEnv = {};
  for (const key of ['PAJ_RUNTIME_DIR', 'PAJ_PROJECT_DIRS', 'PI_CODING_AGENT_DIR', 'XDG_RUNTIME_DIR', 'PATH', 'HOME']) {
    if (typeof sourceEnv[key] === 'string') environment[key] = sourceEnv[key];
  }
  environment.PI_CODING_AGENT_DIR = agentDir;
  const payload = {
    workspace: canonical, policy, home, agentName, model, piExecutable, environment,
  };
  const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const receipt: LaunchReceipt = { version: 1, state: 'prepared', fingerprint, result };
  try { writeReceipt(receiptFile, receipt, true); } catch (error) {
    if (errorCode(error) === 'EEXIST') return repeat();
    throw error;
  }
  try {
    const rechecked = resolveWorkspace(workspace, policy, { home, base: options.base });
    if (rechecked !== canonical) throw new Error('Workspace changed before launch');
    const env = mainEnvironment(sourceEnv, environment, agentName);
    delete env.TMUX;
    delete env.TMUX_PANE;
    const { stdout } = await (options.run ?? execute)('tmux', [
      '-L', 'default', 'new-session', '-d', '-P', '-F', '#{session_name}',
      '-s', tmuxSession, '-c', canonical, nodeExecutable, helper, encoded,
    ], { env, cwd: canonical, timeout: 15000, maxBuffer: 1024 * 1024 });
    if (stdout.trim() !== tmuxSession) throw new Error('tmux did not confirm the exact session name');
    writeReceipt(receiptFile, { ...receipt, state: 'launched' });
    return result;
  } catch (error) {
    try { writeReceipt(receiptFile, { ...receipt, state: 'delivery_unknown' }); } catch {}
    throw new Error(`Main-agent launch outcome uncertain; do not retry: ${errorMessage(error)}`, { cause: error });
  }
}
