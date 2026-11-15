# Compaction integration

Captain adds coordination-specific focus to Pi's existing compaction algorithm. The exact
[guidance](../src/compaction-guidance.md) was reviewed against assignment, reply, launch, and
supersession semantics before the hook was implemented.

## Flow

1. Pi prepares the projected messages to summarize, previous summary, token settings, file
   operations, and retained-message boundary.
2. When Captain is enabled, its `session_before_compact` handler calls Pi's exported `compact()`.
   It uses the supplied preparation rather than rebuilding raw history or choosing a new boundary.
3. A stream adapter appends Captain guidance and any manual compaction instructions to each
   summarization request before sending it through `ctx.modelRegistry.streamSimple()`.
4. Pi's helper generates the summary and file lists. Captain preserves the returned usage, token
   count, and retained boundary, adding only a versioned marker to the details.
5. Pi persists the result and rebuilds context normally. No assignments, replies, launches, or
   messages are submitted by the compaction hook.

Pi 1.2.0 forwards its `customInstructions` argument to history summarization but not split-prefix
summarization. Adding focus at the stream boundary covers both without matching private prompt
strings or making an additional rewrite request. Ordinary compaction usually makes one summary
request; a split turn can require two, and configured transient-error retries can make more.

The guidance retains continuation-relevant facts, not complete reports or a second ledger. It
separates user authorization from worker suggestions, recorded state from activity, and a reported
result from independently verified success. Exact task and launch references help retrieve details
that remain outside the conversation. It also preserves decisions available only in conversation.

## Safety and continuity

The hook passes Pi's operation signal, honors configured summarization retries, and checks that
Captain is still enabled in the same session before accepting a result. Failed, aborted, empty,
tool-calling, or invalid results cancel compaction rather than falling through to an unguided
second attempt. Notification failure cannot turn cancellation into fallback.

Cancellation appends no compaction entry. Existing raw history and Captain state are not deleted.
Pi's overflow recovery may already have omitted a failed attempt from its projected context before
calling the hook; cancelling compaction does not undo those recovery edits or schedule its retry.
The user can address the error and retry `/compact`.

Pi does not automatically carry structured file metadata from hook-generated summaries. Captain
carries only its latest recognized summary's file lists into the next preparation. It also bridges
those lists into stock compaction after `/captain off`, so turning off the focus does not discard
previously recorded files. Other extensions' unknown metadata is not interpreted. If Captain is
uninstalled entirely, Pi's ordinary limitations for hook-generated file metadata apply.

No extra checkpoint database is introduced. The existing assignment ledger and launch receipts
retain last-known recorded state. Neither a summary nor those records authorize additional work.
LLM summarization remains lossy, even with reviewed instructions and mechanical regression tests.

## Compatibility

The integration targets Pi 1.2.0's public compaction helper and model registry. It uses the current
physical model and thinking level, request-time registry authentication/provider configuration,
and effective retry/timeout settings. It does not hardcode a provider, copy credentials between
providers, select a replacement model, or install a second Pi SDK.

Virtual models (`api: "pi-virtual"`) are rejected before making model calls. Pi's native compaction
resolves a virtual model once against the session conversation; registry streaming would instead
route separately against each summary request. The public extension API cannot preserve that
selection contract. Choose a physical model or disable Captain to use stock virtual compaction.

This adapter is not the entire default AgentSession request pipeline. Private host stream wrappers,
provider-header lifecycle hooks, attribution headers, and private summarization-retry UI events
are not reproduced. Custom SDK embedders or extensions depending on that pipeline need separate
compatibility validation; `/captain off` leaves summary generation to Pi. Competing custom
compaction hooks are not composed into one combined summarizer.

Pi's usage aggregation is preserved, including its existing limitations for failed retries and a
failed second split-summary request; it is not a complete accounting of every billed attempt.
