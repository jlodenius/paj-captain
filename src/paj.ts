import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { isRecord, type PajSession, type PajMessage, type MessageKind, type RunCommand } from './types.ts';

const exec = promisify(execFile);
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const kinds = new Set(['request', 'question', 'answer', 'update', 'result']);
const gapReasons = new Set(['unindexed', 'reset', 'changed', 'missing', 'oversized', 'invalid']);
export const PAGE_LIMIT = 128;
const MESSAGE_READ_BYTES = 1024 * 1024;
export function validCursor(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 96 && /^[\x21-\x7e]+$/.test(value);
}
export type PajPage = { status: 'ok'; messages: PajMessage[]; nextCursor: string; hasMore: boolean }
  | { status: 'gap'; reason: string };
const nonempty = (value: unknown): value is string => typeof value === 'string' && value.length > 0;
const isId = (value: unknown): value is string => typeof value === 'string' && uuid.test(value);

export function validSession(value: unknown): value is PajSession {
  return isRecord(value) && isId(value.id) && nonempty(value.name)
    && (value.piSessionId == null || nonempty(value.piSessionId)) && typeof value.role === 'string'
    && (value.parentPiSessionId == null || nonempty(value.parentPiSessionId))
    && nonempty(value.projectId) && nonempty(value.projectRoot)
    && (value.status === 'idle' || value.status === 'busy');
}

export function validMessage(value: unknown): value is PajMessage {
  return isRecord(value) && isRecord(value.from) && isId(value.id) && isId(value.from.id) && nonempty(value.from.name)
    && isId(value.to) && typeof value.text === 'string' && typeof value.kind === 'string' && kinds.has(value.kind)
    && typeof value.createdAtMs === 'number' && Number.isSafeInteger(value.createdAtMs) && value.createdAtMs >= 0
    && (value.taskId == null || nonempty(value.taskId))
    && (value.inReplyTo == null || isId(value.inReplyTo));
}

export function createPajClient({ run = exec, cwd, env = process.env }: {
  run?: RunCommand; cwd?: string; env?: NodeJS.ProcessEnv;
} = {}) {
  async function call(args: string[], maxBuffer = 8 * 1024 * 1024, timeout = 15000): Promise<unknown> {
    const result = await run('paj', ['--json', ...args], {
      cwd, env, timeout, maxBuffer, encoding: 'utf8',
    });
    if (result?.exitCode || result?.exit_code || typeof result?.stdout !== 'string'
        || Buffer.byteLength(result.stdout) > maxBuffer) {
      throw new Error('Paj CLI failed or exceeded output limit');
    }
    try { return JSON.parse(result.stdout); }
    catch { throw new Error('Malformed Paj JSON'); }
  }
  async function sessions(): Promise<PajSession[]> {
    const values = await call(['session', 'list', '--all']);
    if (!Array.isArray(values) || values.length > 10000
        || values.some(value => !validSession(value))) throw new Error('Invalid Paj sessions');
    const validated = values.filter(validSession);
    if (new Set(validated.map(value => value.id)).size !== values.length) {
      throw new Error('Duplicate Paj session identity');
    }
    return validated.filter(value => value.role === 'primary' && value.parentPiSessionId == null
      && nonempty(value.piSessionId));
  }
  return {
    async listMain(selfPiSessionId: string) {
      return (await sessions()).filter(value => value.piSessionId !== selfPiSessionId);
    },
    async self(piSessionId: string) {
      if (!nonempty(piSessionId)) throw new Error('Stable Pi session ID required');
      const matches = (await sessions()).filter(value => value.piSessionId === piSessionId);
      if (matches.length !== 1) throw new Error('Captain main session is unavailable or ambiguous');
      return matches[0];
    },
    async resolveMain(reference: string, selfPiSessionId: string) {
      if (!nonempty(reference)) throw new Error('Exact agent reference required');
      const matches = (await sessions()).filter(value => value.id === reference
        || value.piSessionId === reference || value.name === reference);
      if (matches.length !== 1 || matches[0].piSessionId === selfPiSessionId) {
        throw new Error('Main agent reference is unavailable, ambiguous, or self');
      }
      return matches[0];
    },
    async send({ from, recipient, text, kind, taskId, inReplyTo }: {
      from: string; recipient: string; text: string; kind: MessageKind; taskId?: string; inReplyTo?: string;
    }) {
      if (!isId(from) || !isId(recipient) || !nonempty(text)
          || Buffer.byteLength(text) > 16384 || !kinds.has(kind)
          || (taskId != null && !nonempty(taskId))
          || (inReplyTo != null && !isId(inReplyTo))) throw new Error('Invalid Paj send');
      const args = ['message', 'send', recipient, '--from', from, `--text=${text}`, '--kind', kind];
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
    async getMessage(recipientId: string, messageId: string): Promise<PajMessage | undefined> {
      if (!isId(recipientId) || !isId(messageId)) throw new Error('Invalid Paj message lookup');
      const result = await call(['message', 'get', recipientId, messageId], MESSAGE_READ_BYTES, 5000);
      if (isRecord(result) && result.status === 'not-found') return undefined;
      if (!isRecord(result) || result.status !== 'ok' || !validMessage(result.message)
          || result.message.id !== messageId.toLowerCase() || result.message.to !== recipientId.toLowerCase()
          || (result.message.taskId !== undefined && !nonempty(result.message.taskId))) {
        throw new Error('Invalid or uncorrelated Paj message lookup response');
      }
      return result.message;
    },
    async readPage(pajSessionId: string, after?: string): Promise<PajPage> {
      if (!isId(pajSessionId) || (after !== undefined && !validCursor(after))) throw new Error('Invalid Paj read position');
      const page = await call(['message', 'read', pajSessionId, '--limit', String(PAGE_LIMIT),
        ...(after === undefined ? [] : ['--after', after])], MESSAGE_READ_BYTES, 5000);
      if (isRecord(page) && page.status === 'gap' && typeof page.reason === 'string' && gapReasons.has(page.reason)) {
        return { status: 'gap', reason: page.reason };
      }
      if (!isRecord(page) || page.status !== 'ok' || !validCursor(page.nextCursor) || typeof page.hasMore !== 'boolean'
          || !Array.isArray(page.messages) || page.messages.length > PAGE_LIMIT
          || page.messages.some(message => !validMessage(message) || message.to !== pajSessionId)
          || new Set(page.messages.map(message => message.id)).size !== page.messages.length
          || (page.messages.length === 0 && (page.hasMore || (after !== undefined && after !== page.nextCursor)))
          || (page.messages.length !== 0 && after === page.nextCursor)) throw new Error('Invalid Paj message page');
      return { status: 'ok', messages: page.messages, nextCursor: page.nextCursor, hasMore: page.hasMore };
    },
  };
}
