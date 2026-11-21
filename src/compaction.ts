import { readFileSync } from "node:fs";
import type {
  compact as piCompact,
  ExtensionAPI,
  ExtensionContext,
  SessionBeforeCompactEvent,
  SessionBeforeCompactResult,
  SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { isRecord } from "./types.ts";

type Preparation = SessionBeforeCompactEvent["preparation"];
type Compact = typeof piCompact;
type Stream = NonNullable<Parameters<Compact>[7]>;

export const CAPTAIN_COMPACTION_GUIDANCE = readFileSync(
  new URL("./compaction-guidance.md", import.meta.url),
  "utf8",
).trim();

export function carryCaptainFiles(
  preparation: Preparation,
  entries: SessionEntry[],
): Preparation {
  const previous = [...entries]
    .reverse()
    .find((entry) => entry.type === "compaction");
  if (
    !previous?.fromHook ||
    !isRecord(previous.details) ||
    previous.details.pajCaptainCompaction !== 1
  )
    return preparation;
  if (previous.summary !== preparation.previousSummary)
    throw new Error("Captain compaction history changed");
  const { readFiles, modifiedFiles } = previous.details;
  const stringArray = (value: unknown): value is string[] =>
    Array.isArray(value) && value.every((file) => typeof file === "string");
  if (!stringArray(readFiles) || !stringArray(modifiedFiles)) {
    throw new Error("Invalid Captain compaction file metadata");
  }
  const fileOps = {
    read: new Set(preparation.fileOps.read),
    written: new Set(preparation.fileOps.written),
    edited: new Set(preparation.fileOps.edited),
  };
  for (const file of readFiles) fileOps.read.add(file);
  for (const file of modifiedFiles) fileOps.edited.add(file);
  return { ...preparation, fileOps };
}

export function supportsCaptainCompaction(version?: string) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version ?? "");
  if (!match) return false;
  const [major, minor, patch] = match.slice(1).map(Number);
  return (
    major > 1 || (major === 1 && (minor > 5 || (minor === 5 && patch >= 2)))
  );
}

export function cancelCaptainCompaction(
  ctx: ExtensionContext,
  error: unknown,
  signal?: AbortSignal,
): SessionBeforeCompactResult {
  if (!signal?.aborted) {
    try {
      const message = error instanceof Error ? error.message : String(error);
      ctx.ui.notify(
        `Captain compaction cancelled: ${message}. No unguided retry was performed.`,
        "warning",
      );
    } catch {}
  }
  return { cancel: true };
}

export async function compactCaptain(
  event: SessionBeforeCompactEvent,
  ctx: ExtensionContext,
  {
    compact,
    settings = {},
    thinkingLevel,
    isCurrent = () => true,
  }: {
    compact?: Compact;
    settings?: ReturnType<ExtensionAPI["getSettings"]>;
    thinkingLevel?: Parameters<Compact>[6];
    isCurrent?: () => boolean;
  },
): Promise<SessionBeforeCompactResult> {
  const check = () => {
    event.signal.throwIfAborted();
    if (!isCurrent())
      throw new Error("Captain session or mode changed during compaction");
  };
  try {
    check();
    if (
      !ctx.model ||
      typeof compact !== "function" ||
      typeof ctx.modelRegistry?.streamSimple !== "function"
    ) {
      throw new Error("Pi compaction API or current model is unavailable");
    }
    if (ctx.model.api === "pi-virtual") {
      throw new Error(
        "Captain compaction cannot preserve virtual-model routing; use a physical model or disable Captain before compacting",
      );
    }
    const focus = [
      CAPTAIN_COMPACTION_GUIDANCE,
      event.customInstructions
        ? `User-supplied compaction focus:\n${event.customInstructions}`
        : "",
    ]
      .filter(Boolean)
      .join("\n\n");
    const retry = {
      enabled: settings.retry?.enabled ?? true,
      maxRetries: settings.retry?.maxRetries ?? 3,
      baseDelayMs: settings.retry?.baseDelayMs ?? 2000,
      maxAgentDelayMs: settings.retry?.maxAgentDelayMs ?? 60000,
    };
    const requestOptions = {
      timeoutMs:
        settings.retry?.provider?.timeoutMs ??
        (settings.httpIdleTimeoutMs === 0
          ? 2147483647
          : (settings.httpIdleTimeoutMs ?? 300000)),
      websocketConnectTimeoutMs: settings.websocketConnectTimeoutMs ?? 15000,
      maxRetries: settings.retry?.provider?.maxRetries,
      maxRetryDelayMs: settings.retry?.provider?.maxRetryDelayMs ?? 60000,
    };
    const stream: Stream = async (model, context, options) => {
      check();
      const merged = { ...requestOptions, ...options };
      const responseStream = ctx.modelRegistry.streamSimple(model, context, {
        ...merged,
        timeoutMs:
          merged.timeoutMs === "disabled" ? 2147483647 : merged.timeoutMs,
        websocketConnectTimeoutMs:
          merged.websocketConnectTimeoutMs === "disabled"
            ? 2147483647
            : merged.websocketConnectTimeoutMs,
      });
      const response = await responseStream.result();
      check();
      if (response.stopReason === "aborted")
        throw new Error("Provider aborted Captain compaction");
      if (
        response.stopReason !== "error" &&
        response.stopReason !== "length" &&
        !response.content.some(
          (part) => part.type === "text" && part.text.trim(),
        )
      ) {
        throw new Error("Provider returned an empty Captain summary");
      }
      if (response.content.some((part) => part.type === "toolCall"))
        throw new Error("Summarization attempted a tool call");
      return responseStream;
    };
    const preparation = carryCaptainFiles(
      event.preparation,
      event.branchEntries,
    );
    const result = await compact(
      preparation,
      ctx.model,
      undefined,
      undefined,
      focus,
      event.signal,
      thinkingLevel,
      stream,
      undefined,
      retry,
    );
    check();
    if (
      !result.summary?.trim() ||
      result.firstKeptEntryId !== preparation.firstKeptEntryId ||
      result.tokensBefore !== preparation.tokensBefore
    )
      throw new Error("Invalid Captain compaction result");
    return {
      compaction: {
        ...result,
        details: {
          ...(isRecord(result.details) ? result.details : {}),
          pajCaptainCompaction: 1,
        },
      },
    };
  } catch (error) {
    return cancelCaptainCompaction(ctx, error, event.signal);
  }
}
