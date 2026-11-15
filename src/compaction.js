import { readFileSync } from 'node:fs';

export const CAPTAIN_COMPACTION_GUIDANCE = readFileSync(new URL('./compaction-guidance.md', import.meta.url), 'utf8').trim();

export function carryCaptainFiles(preparation, entries) {
  const previous = [...entries].reverse().find(entry => entry.type === 'compaction');
  if (!previous?.fromHook || previous.details?.pajCaptainCompaction !== 1) return preparation;
  if (previous.summary !== preparation.previousSummary) throw new Error('Captain compaction history changed');
  const { readFiles, modifiedFiles } = previous.details;
  if (![readFiles, modifiedFiles].every(files => Array.isArray(files) && files.every(file => typeof file === 'string'))) {
    throw new Error('Invalid Captain compaction file metadata');
  }
  const fileOps = Object.fromEntries(Object.entries(preparation.fileOps).map(([key, value]) => [key, new Set(value)]));
  for (const file of readFiles) fileOps.read.add(file);
  for (const file of modifiedFiles) fileOps.edited.add(file);
  return { ...preparation, fileOps };
}

function focusedContext(context, focus) {
  const messages = [...context.messages];
  const last = messages.at(-1);
  if (last?.role !== 'user') throw new Error('Unsupported Pi summarization context');
  const text = `\n\n# Additional summary focus\n${focus}`;
  messages[messages.length - 1] = { ...last, content: typeof last.content === 'string'
    ? last.content + text : [...last.content, { type: 'text', text }] };
  return { ...context, messages };
}

export function cancelCaptainCompaction(ctx, error, signal) {
  if (!signal?.aborted) {
    try {
      const message = error instanceof Error ? error.message : String(error);
      ctx.ui.notify(`Captain compaction cancelled: ${message}. No unguided retry was performed.`, 'warning');
    } catch {}
  }
  return { cancel: true };
}

export async function compactCaptain(event, ctx, { compact, settings = {}, thinkingLevel, isCurrent = () => true }) {
  const check = () => {
    event.signal.throwIfAborted();
    if (!isCurrent()) throw new Error('Captain session or mode changed during compaction');
  };
  try {
    check();
    if (!ctx.model || typeof compact !== 'function' || typeof ctx.modelRegistry?.streamSimple !== 'function') {
      throw new Error('Pi compaction API or current model is unavailable');
    }
    if (ctx.model.api === 'pi-virtual') {
      throw new Error('Captain compaction cannot preserve virtual-model routing; use a physical model or disable Captain before compacting');
    }
    const focus = [CAPTAIN_COMPACTION_GUIDANCE, event.customInstructions
      ? `User-supplied compaction focus:\n${event.customInstructions}` : ''].filter(Boolean).join('\n\n');
    const retry = {
      enabled: settings.retry?.enabled ?? true,
      maxRetries: settings.retry?.maxRetries ?? 3,
      baseDelayMs: settings.retry?.baseDelayMs ?? 2000,
      maxAgentDelayMs: settings.retry?.maxAgentDelayMs ?? 60000,
    };
    const requestOptions = {
      timeoutMs: settings.retry?.provider?.timeoutMs
        ?? (settings.httpIdleTimeoutMs === 0 ? 2147483647 : settings.httpIdleTimeoutMs ?? 300000),
      websocketConnectTimeoutMs: settings.websocketConnectTimeoutMs ?? 15000,
      maxRetries: settings.retry?.provider?.maxRetries,
      maxRetryDelayMs: settings.retry?.provider?.maxRetryDelayMs ?? 60000,
    };
    const stream = async (model, context, options) => {
      check();
      // Pi's helper omits customInstructions on split-prefix requests; focus every request here.
      const responseStream = ctx.modelRegistry.streamSimple(model, focusedContext(context, focus), { ...requestOptions, ...options });
      const response = await responseStream.result();
      check();
      if (response.stopReason === 'aborted') throw new Error('Provider aborted Captain compaction');
      if (response.stopReason !== 'error' && response.stopReason !== 'length'
        && !response.content.some(part => part.type === 'text' && part.text.trim())) {
        throw new Error('Provider returned an empty Captain summary');
      }
      if (response.content.some(part => part.type === 'toolCall')) throw new Error('Summarization attempted a tool call');
      return responseStream;
    };
    const preparation = carryCaptainFiles(event.preparation, event.branchEntries);
    const result = await compact(preparation, ctx.model, undefined, undefined, undefined,
      event.signal, thinkingLevel, stream, undefined, retry);
    check();
    if (!result.summary?.trim() || result.firstKeptEntryId !== preparation.firstKeptEntryId
      || result.tokensBefore !== preparation.tokensBefore) throw new Error('Invalid Captain compaction result');
    return { compaction: { ...result, details: { ...result.details, pajCaptainCompaction: 1 } } };
  } catch (error) {
    return cancelCaptainCompaction(ctx, error, event.signal);
  }
}
