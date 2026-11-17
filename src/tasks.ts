import { errorCode, type Ledger, type Task, type PajMessage, type PajSession } from './types.ts';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { validMessage, validSession } from './paj.ts';

const MAX_TASKS = 128;
const MAX_SEEN = 512;
const MAX_QUESTIONS = 64;
const MAX_BYTES = 16 * 1024 * 1024;
const statuses = new Set(['prepared', 'queued', 'delivery_unknown', 'waiting_for_answer', 'completed']);
const replyStatuses = new Set(['prepared', 'queued', 'delivery_unknown']);
const clone = <T>(value: T): T => structuredClone(value);
const text = (value: unknown): value is string => typeof value === 'string' && value.length > 0
  && Buffer.byteLength(value) <= 16384;
const short = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 256;
const exactId = (value: unknown): value is string => typeof value === 'string'
  && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
const boundedText = (value: string) => {
  let result = Buffer.from(value).subarray(0, 16384).toString('utf8');
  while (Buffer.byteLength(result) > 16384) result = result.slice(0, -1);
  return result;
};

function securePath(file: string) {
  const absolute = path.resolve(file);
  const parent = path.dirname(absolute);
  let current = path.parse(parent).root;
  for (const part of parent.slice(current.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    try { fs.mkdirSync(current, { mode: 0o700 }); }
    catch (error) { if (errorCode(error) !== 'EEXIST') throw error; }
    const stat = fs.lstatSync(current);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Unsafe ledger directory');
  }
  const stat = fs.statSync(parent);
  if ((stat.mode & 0o077) !== 0 || stat.uid !== process.getuid!()) {
    throw new Error('Ledger directory must be private and owned by current user');
  }
  return absolute;
}

function validate(state: Ledger): Ledger {
  if (!state || state.version !== 1 || !Array.isArray(state.tasks)
      || state.tasks.length > MAX_TASKS) throw new Error('Corrupt task ledger');
  const ids = new Set();
  const requests = new Set();
  const owner = state.tasks[0]?.ownerPiSessionId;
  for (const task of state.tasks) {
    if (!short(task.id) || ids.has(task.id) || !short(task.requestId) || requests.has(task.requestId)
        || !short(task.ownerPiSessionId) || task.ownerPiSessionId !== owner
        || !exactId(task.ownerPajSessionId)
        || !validSession(task.target) || !short(task.target.piSessionId) || task.target.role !== 'primary'
        || task.target.piSessionId === task.ownerPiSessionId || task.target.id === task.ownerPajSessionId
        || task.target.parentPiSessionId != null || !text(task.assignment)
        || !statuses.has(task.status) || !Array.isArray(task.seenMessageIds)
        || task.seenMessageIds.length > MAX_SEEN || task.seenMessageIds.some(id => !exactId(id))
        || new Set(task.seenMessageIds).size !== task.seenMessageIds.length
        || !Array.isArray(task.questions) || task.questions.length > MAX_QUESTIONS
        || !Array.isArray(task.events) || task.events.length > 64
        || !Array.isArray(task.replies) || task.replies.length > MAX_QUESTIONS
        || !Number.isSafeInteger(task.createdAtMs) || task.createdAtMs < 0
        || !Number.isSafeInteger(task.updatedAtMs) || task.updatedAtMs < 0
        || (task.requestMessageId != null && !exactId(task.requestMessageId))
        || (task.result != null && !storedMessage(task.result, task, ['result']))
        || (task.status === 'completed') !== (task.result != null)
        || task.questions.some(value => !storedMessage(value, task, ['question'])
          || (value.supersededBy != null && (!exactId(value.supersededBy) || value.supersededBy === value.id)))
        || (task.questionsTruncated != null && typeof task.questionsTruncated !== 'boolean')
        || task.events.some(value => !storedMessage(value, task, ['question', 'update', 'result', 'answer']))
        || new Set(task.questions.map(value => value.id)).size !== task.questions.length
        || new Set(task.replies.map(value => value.questionId)).size !== task.replies.length
        || task.replies.some(value => !replyStatuses.has(value.status) || !text(value.text)
          || !Number.isSafeInteger(value.createdAtMs) || value.createdAtMs < 0
          || !task.questions.some(question => question.id === value.questionId)
          || (value.messageId != null && !exactId(value.messageId))
          || (value.status === 'queued' && !exactId(value.messageId)))) {
      throw new Error('Corrupt task ledger');
    }
    ids.add(task.id);
    requests.add(task.requestId);
  }
  return state;
}

function storedMessage(message: unknown, task: Task, kinds: string[]): message is PajMessage {
  return validMessage(message) && text(message.text) && kinds.includes(message.kind)
    && message.from.id === task.target.id && message.to === task.ownerPajSessionId
    && message.taskId === task.id && message.senderTaskId == null && message.recipientTaskId == null
    && (message.supersedes == null || exactId(message.supersedes));
}

function correlated(message: unknown, task: Task): message is PajMessage {
  return validMessage(message) && message.from.id === task.target.id
    && message.to === task.ownerPajSessionId && message.taskId === task.id
    && message.senderTaskId == null && message.recipientTaskId == null;
}

export function createTaskStore(file: string, { now = Date.now, id = randomUUID }: {
  now?: () => number; id?: () => string;
} = {}) {
  file = securePath(file);
  const lock = `${file}.lock`;
  let initialized = false;
  function load(): Ledger {
    let descriptor;
    try {
      descriptor = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
      const stat = fs.fstatSync(descriptor);
      if (!stat.isFile() || stat.size > MAX_BYTES || (stat.mode & 0o077) !== 0
          || stat.uid !== process.getuid!() || stat.nlink !== 1) throw new Error('Unsafe ledger file');
      return validate(JSON.parse(fs.readFileSync(descriptor, 'utf8')));
    } catch (error) {
      if (errorCode(error) === 'ENOENT' && !initialized) return { version: 1, tasks: [] };
      throw error;
    } finally { if (descriptor !== undefined) fs.closeSync(descriptor); }
  }
  function save(state: Ledger) {
    validate(state);
    const data = JSON.stringify(state);
    if (Buffer.byteLength(data) > MAX_BYTES) throw new Error('Task ledger capacity exceeded');
    const temporary = `${file}.${randomUUID()}.tmp`;
    let descriptor;
    try {
      descriptor = fs.openSync(temporary, 'wx', 0o600);
      fs.writeFileSync(descriptor, data);
      fs.fsyncSync(descriptor);
      fs.closeSync(descriptor);
      descriptor = undefined;
      fs.renameSync(temporary, file);
      const directory = fs.openSync(path.dirname(file), fs.constants.O_RDONLY);
      try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
    } finally {
      if (descriptor !== undefined) fs.closeSync(descriptor);
      try { fs.unlinkSync(temporary); } catch (error) { if (errorCode(error) !== 'ENOENT') throw error; }
    }
  }
  function transact<T>(fn: (state: Ledger) => T): T {
    securePath(file);
    const descriptor = fs.openSync(lock,
      fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_NOFOLLOW, 0o600);
    try {
      const stat = fs.fstatSync(descriptor);
      if (!stat.isFile() || (stat.mode & 0o077) !== 0 || stat.uid !== process.getuid!()
          || stat.nlink !== 1) throw new Error('Unsafe ledger lock');
      const acquired = spawnSync('flock', ['-n', '3'], {
        stdio: ['ignore', 'pipe', 'pipe', descriptor], timeout: 5000, maxBuffer: 65536,
      });
      if (acquired.error || acquired.status !== 0) {
        throw new Error('Ledger lock unavailable', { cause: acquired.error });
      }
      const current = fs.lstatSync(lock);
      if (current.ino !== stat.ino || current.dev !== stat.dev) throw new Error('Ledger lock changed');
      const state = load();
      const result = fn(state);
      save(state);
      return clone(result);
    } finally {
      fs.closeSync(descriptor);
    }
  }
  function taskIn(state: Ledger, taskId: string): Task {
    const task = state.tasks.find(value => value.id === taskId);
    if (!task) throw new Error('Unknown assignment');
    return task;
  }
  function mutate(taskId: string, fn: (task: Task) => void): Task {
    return transact(state => {
      const task = taskIn(state, taskId);
      fn(task);
      task.updatedAtMs = now();
      return task;
    });
  }
  function questionIn(task: Task, questionId: string): PajMessage {
    if (task.status === 'completed') throw new Error('Assignment is completed');
    const question = task.questions.find(value => value.id === questionId);
    if (!question) throw new Error('Unknown assignment question');
    if (question.supersededBy) throw new Error('Assignment question was superseded');
    return question;
  }
  function refreshStatus(task: Task) {
    if (task.status === 'completed') return;
    task.status = task.questions.some(question => !question.supersededBy && !task.replies.some(reply =>
      reply.questionId === question.id && reply.status === 'queued'))
      ? 'waiting_for_answer' : (task.requestMessageId ? 'queued' : 'delivery_unknown');
  }
  transact(state => {
    for (const task of state.tasks) {
      if (task.status === 'prepared') task.status = 'delivery_unknown';
      for (const reply of task.replies) {
        if (reply.status === 'prepared') reply.status = 'delivery_unknown';
      }
    }
    return null;
  });
  initialized = true;
  return {
    list() { securePath(file); return clone(load().tasks); },
    get(taskId: string) { securePath(file); return clone(load().tasks.find(value => value.id === taskId)); },
    begin({ requestId, ownerPiSessionId, ownerPajSessionId, target, assignment }: {
      requestId: string; ownerPiSessionId: string; ownerPajSessionId: string;
      target: PajSession; assignment: string;
    }) {
      return transact(state => {
        if (state.tasks.some(task => task.ownerPiSessionId !== ownerPiSessionId)) {
          throw new Error('Ledger belongs to another Captain session');
        }
        const existing = state.tasks.find(task => task.requestId === requestId);
        if (existing) {
          if (existing.ownerPiSessionId !== ownerPiSessionId
              || existing.ownerPajSessionId !== ownerPajSessionId
              || existing.target.id !== target?.id
              || existing.target.piSessionId !== target?.piSessionId
              || existing.assignment !== assignment) throw new Error('Conflicting request ID reuse');
          return { ...existing, reused: true };
        }
        if (state.tasks.length >= MAX_TASKS) throw new Error('Task ledger is full');
        const task: Task = { id: id(), requestId, ownerPiSessionId, ownerPajSessionId,
          target: clone(target), assignment, status: 'prepared', createdAtMs: now(),
          updatedAtMs: now(), requestMessageId: null, questions: [], events: [],
          result: null, replies: [], seenMessageIds: [] };
        state.tasks.push(task);
        return { ...task, reused: false };
      });
    },
    markSent(taskId: string, message: unknown) {
      return mutate(taskId, task => {
        if (!validMessage(message) || message.from.id !== task.ownerPajSessionId
            || message.to !== task.target.id || message.taskId !== task.id
            || message.kind !== 'request' || message.text !== task.assignment
            || (task.requestMessageId && task.requestMessageId !== message.id)) {
          throw new Error('Uncorrelated assignment send');
        }
        task.requestMessageId = message.id;
        refreshStatus(task);
      });
    },
    markUnknown(taskId: string, error?: unknown) {
      return mutate(taskId, task => {
        if (task.status === 'prepared' || task.status === 'delivery_unknown') {
          task.status = 'delivery_unknown';
          if (error) task.deliveryError = boundedText(String(error));
        }
      });
    },
    observe(messages: readonly unknown[]) {
      if (!Array.isArray(messages) || messages.length > 40000) throw new Error('Invalid observations');
      return transact(state => {
        const changed = new Set<Task>();
        const incoming = new Map(messages.filter(validMessage).map(message => [message.id, message]));
        const replacements: { task: Task; message: PajMessage }[] = [];
        for (const message of messages) {
          if (!validMessage(message)) continue;
          const task = state.tasks.find(value => value.id === message.taskId);
          if (!task || task.status === 'completed' || !correlated(message, task)
              || !['question', 'update', 'result', 'answer'].includes(message.kind)) continue;
          let original;
          if (message.supersedes != null) {
            original = task.questions.find(value => value.id === message.supersedes)
              ?? task.events.find(value => value.id === message.supersedes)
              ?? incoming.get(message.supersedes);
            if (!exactId(message.supersedes) || !original || original.id === message.id
                || !correlated(original, task) || original.createdAtMs > message.createdAtMs
                || (original.supersededBy && original.supersededBy !== message.id)) continue;
          }
          if (task.seenMessageIds.includes(message.id)
              || task.questions.some(question => question.id === message.id)
              || original?.supersededBy === message.id) {
            if (original) replacements.push({ task, message });
            continue;
          }
          const replacesQuestion = original?.kind === 'question';
          if (message.kind !== 'result' && message.kind !== 'question' && !replacesQuestion
              && task.seenMessageIds.length >= MAX_SEEN) continue;
          if (message.kind === 'question' && task.questions.length >= MAX_QUESTIONS) {
            if (original) replacements.push({ task, message });
            if (!task.questionsTruncated) {
              task.questionsTruncated = true;
              task.updatedAtMs = now();
              changed.add(task);
            }
            continue;
          }
          const event = { ...clone(message), text: boundedText(message.text || '(empty)') };
          if (task.seenMessageIds.length < MAX_SEEN) task.seenMessageIds.push(message.id);
          task.events.push(event);
          task.events = task.events.slice(-64);
          if (message.kind === 'question') task.questions.push(event);
          if (original) replacements.push({ task, message });
          if (message.kind === 'result') { task.result = event; task.status = 'completed'; }
          refreshStatus(task);
          task.updatedAtMs = now();
          changed.add(task);
        }
        for (const { task, message } of replacements) {
          const question = task.questions.find(value => value.id === message.supersedes);
          if (!question || question.supersededBy) continue;
          question.supersededBy = message.id;
          refreshStatus(task);
          task.updatedAtMs = now();
          changed.add(task);
        }
        return [...changed];
      });
    },
    prepareReply(taskId: string, { questionId, text: replyText }: { questionId: string; text: string }) {
      return transact(state => {
        const task = taskIn(state, taskId);
        questionIn(task, questionId);
        if (!text(replyText)) throw new Error('Invalid reply text');
        const existing = task.replies.find(reply => reply.questionId === questionId);
        if (existing) {
          if (existing.text !== replyText) throw new Error('Conflicting reply intent');
          return { ...task, reused: true };
        }
        task.replies.push({ questionId, text: replyText, status: 'prepared', createdAtMs: now() });
        task.updatedAtMs = now();
        return { ...task, reused: false };
      });
    },
    markReplyUnknown(taskId: string, { questionId, error }: { questionId: string; error?: unknown }) {
      return mutate(taskId, task => {
        const reply = task.replies.find(value => value.questionId === questionId);
        if (!reply) throw new Error('Missing reply intent');
        if (reply.status !== 'queued') {
          reply.status = 'delivery_unknown';
          if (error) reply.deliveryError = boundedText(String(error));
        }
      });
    },
    recordReply(taskId: string, { questionId, message }: { questionId: string; message: unknown }) {
      return mutate(taskId, task => {
        questionIn(task, questionId);
        const reply = task.replies.find(value => value.questionId === questionId);
        if (!reply || !validMessage(message) || message.kind !== 'answer'
            || message.from.id !== task.ownerPajSessionId || message.to !== task.target.id
            || message.taskId !== task.id || message.inReplyTo !== questionId
            || message.text !== reply.text || (reply.messageId && reply.messageId !== message.id)) {
          throw new Error('Uncorrelated reply or missing reply intent');
        }
        reply.messageId = message.id;
        reply.status = 'queued';
        refreshStatus(task);
      });
    },
  };
}
