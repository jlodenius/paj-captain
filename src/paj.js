import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const kinds = new Set(['request', 'question', 'answer', 'update', 'result']);
const nonempty = value => typeof value === 'string' && value.length > 0;
const isId = value => typeof value === 'string' && uuid.test(value);

export function validSession(value) {
  return value && isId(value.id) && nonempty(value.name)
    && (value.piSessionId == null || nonempty(value.piSessionId)) && typeof value.role === 'string'
    && (value.parentPiSessionId == null || nonempty(value.parentPiSessionId))
    && nonempty(value.projectId) && nonempty(value.projectRoot)
    && ['idle', 'busy'].includes(value.status);
}

export function validMessage(value) {
  return value && isId(value.id) && isId(value.from?.id) && nonempty(value.from?.name)
    && isId(value.to) && typeof value.text === 'string' && kinds.has(value.kind)
    && Number.isSafeInteger(value.createdAtMs) && value.createdAtMs >= 0
    && (value.taskId == null || nonempty(value.taskId))
    && (value.inReplyTo == null || isId(value.inReplyTo));
}

export function createPajClient({ run = exec, cwd, env = process.env } = {}) {
  async function call(args) {
    const result = await run('paj', ['--json', ...args], {
      cwd, env, timeout: 15000, maxBuffer: 8 * 1024 * 1024, encoding: 'utf8',
    });
    if (result?.exitCode || result?.exit_code || typeof result?.stdout !== 'string'
        || Buffer.byteLength(result.stdout) > 8 * 1024 * 1024) {
      throw new Error('Paj CLI failed or exceeded output limit');
    }
    try { return JSON.parse(result.stdout); }
    catch { throw new Error('Malformed Paj JSON'); }
  }
  async function sessions() {
    const values = await call(['session', 'list', '--all']);
    if (!Array.isArray(values) || values.length > 10000
        || values.some(value => !validSession(value))) throw new Error('Invalid Paj sessions');
    if (new Set(values.map(value => value.id)).size !== values.length) {
      throw new Error('Duplicate Paj session identity');
    }
    return values.filter(value => value.role === 'primary' && value.parentPiSessionId == null
      && nonempty(value.piSessionId));
  }
  return {
    async listMain(selfPiSessionId) {
      return (await sessions()).filter(value => value.piSessionId !== selfPiSessionId);
    },
    async self(piSessionId) {
      if (!nonempty(piSessionId)) throw new Error('Stable Pi session ID required');
      const matches = (await sessions()).filter(value => value.piSessionId === piSessionId);
      if (matches.length !== 1) throw new Error('Captain main session is unavailable or ambiguous');
      return matches[0];
    },
    async resolveMain(reference, selfPiSessionId) {
      if (!nonempty(reference)) throw new Error('Exact agent reference required');
      const matches = (await sessions()).filter(value => value.id === reference
        || value.piSessionId === reference || value.name === reference);
      if (matches.length !== 1 || matches[0].piSessionId === selfPiSessionId) {
        throw new Error('Main agent reference is unavailable, ambiguous, or self');
      }
      return matches[0];
    },
    async send({ from, recipient, text, kind, taskId, inReplyTo }) {
      if (!isId(from) || !isId(recipient) || !nonempty(text)
          || Buffer.byteLength(text) > 16384 || !kinds.has(kind)
          || (taskId != null && !nonempty(taskId))
          || (inReplyTo != null && !isId(inReplyTo))) throw new Error('Invalid Paj send');
      const args = ['message', 'send', recipient, '--from', from, '--text', text, '--kind', kind];
      if (taskId != null) args.push('--task-id', taskId);
      if (inReplyTo != null) args.push('--in-reply-to', inReplyTo);
      const message = await call(args);
      if (!validMessage(message) || message.from.id !== from || message.to !== recipient
          || message.text !== text || message.kind !== kind
          || message.taskId !== taskId || message.inReplyTo !== inReplyTo) {
        throw new Error('Invalid or uncorrelated Paj send response; delivery unknown');
      }
      return message;
    },
    async incoming(pajSessionId) {
      if (!isId(pajSessionId)) throw new Error('Exact Paj session ID required');
      const batches = await Promise.all(['history', 'pending'].map(async command => {
        const values = await call(['message', command, pajSessionId]);
        if (!Array.isArray(values) || values.length > 20000
            || values.some(value => !validMessage(value) || value.to !== pajSessionId)) {
          throw new Error('Invalid Paj inbox');
        }
        return values;
      }));
      const messages = new Map();
      for (const value of batches.flat()) {
        if (messages.has(value.id) && JSON.stringify(messages.get(value.id)) !== JSON.stringify(value)) {
          throw new Error('Conflicting Paj message identity');
        }
        messages.set(value.id, value);
      }
      return [...messages.values()].sort((a, b) => a.createdAtMs - b.createdAtMs
        || a.id.localeCompare(b.id));
    },
  };
}
