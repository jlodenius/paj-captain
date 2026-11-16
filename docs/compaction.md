# Compaction integration

When Captain is enabled, a [short checklist](../src/compaction-guidance.md) preserves assignment,
question, launch, and evidence references. The per-turn Captain reminder tells the agent to reread
the complete Captain skill after compaction and consult `captain_tasks` for current details.
`/captain off` restores Pi's ordinary summarization.

## Flow

Captain uses Pi's public `compact()` helper with the existing preparation and retained-message
boundary. It combines Captain guidance with any manual compaction focus, applying both to history
and split-turn summaries. It uses the current physical model and thinking level through Pi's model
registry, without changing providers or copying credentials.

There is no second summary pass or checkpoint database. Compaction does not send messages, reply
to workers, or launch agents. The assignment ledger and launch receipts remain the records of
external actions; summaries retain only the context and references needed to continue.

A split turn may require two summary requests, and retries can add more. Providers determine the
summary output budget; `reserveTokens` controls the compaction threshold. Returned usage follows
Pi's accounting and may omit failed attempts.

## Safety and continuity

Failed, aborted, empty, tool-calling, invalid, or stale results cancel compaction without an
unguided fallback. Cancellation appends no compaction entry and leaves Captain state unchanged.
Pi's overflow recovery may already have adjusted projected context before the hook runs; cancelling
does not undo those edits. Address the error and retry `/compact`.

Captain carries recognized file metadata between its summaries and into stock compaction after
`/captain off`. Uninstalling Captain removes that compatibility handling. Summarization remains
lossy; neither summaries nor recorded task states grant permission for additional work.

## Compatibility

Requires stable Pi 1.5.2 or newer. Restart Pi after upgrading its core; `/reload` updates extensions
only. Unsupported running versions cancel guided compaction before making a model request.

Virtual models (`api: "pi-virtual"`) are unsupported because registry streaming cannot preserve
Pi's session-level routing decision across summary requests. Select a physical model or disable
Captain to use stock compaction.

The adapter does not reproduce Pi's private host stream wrappers, provider-header lifecycle hooks,
attribution headers, or retry UI events. Custom integrations relying on those features need
separate validation. Competing custom compaction hooks are not combined.
