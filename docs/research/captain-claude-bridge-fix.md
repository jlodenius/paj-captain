# Research: fixing Captain instructions through the Claude bridge

## Recommendation

**Yes, it is fixable. Keep using GPT/Codex if that is acceptable; this research requires no
configuration or model switch.** The immediate incompatibility is between Captain's whole-prompt
return and the Claude bridge's selective projection, not Fable's model quality or tool support.
The bridge deliberately avoids forwarding Pi's entire harness. Captain can use a supported
injection interface without weakening that protection. [Captain hook][captain]
[Bridge compatibility and known issues][readme] [Bridge projection][capture]

Recommended ownership and scope:

- **Captain-side structured append is the smallest clean fix for profile transport.** Mutate
  `event.systemPromptOptions.appendSystemPrompt` in place, preserving existing append text, and
  stop returning `systemPrompt`. This works through the installed bridge's capture/projection
  path in either handler order, and retains system-level placement on ordinary Pi providers.
- **That change alone is not sufficient for current dynamic Captain behavior on resumed Claude
  sessions.** The bridge documents that mid-session prompt changes may remain stale until a
  rebuild. Captain includes per-run task summaries, freshness warnings, reporting settings, and
  invalid-configuration instructions. Put such current-run information in a hidden custom
  `before_agent_start` message if immediate delivery is required.
- **The smallest robust transport workaround for all Captain-added text is the custom-message
  route**, including invalid configuration and any enable/off transition notice. It has lower
  instruction priority than a system append and adds conversation history, so it is not
  semantically identical. A static system profile plus dynamic messages is cleaner separation
  but a larger change.
- **A bridge-side fix is optional for the immediate workaround, but needed for a general promise
  that changing system instructions reaches already-resumed Claude sessions.** A general bridge
  solution should explicitly handle supported prompt changes, session synchronization, and
  cache consequences. Do not fix this by sending Pi's whole prompt verbatim.

These recommendations follow source tracing and an offline projection fixture, not a successful
live Claude request. [Pi extension contract][extensions] [Pi event runner][runner]
[Bridge capture/query setup and session synchronization][bridge] [Bridge known issues][readme]

## Evidence baseline

The inspected installed bridge is the Nix-installed `pi-claude-agent-sdk` version `0.9.2`.
The local Nix flake lock pins its input to
`36a20bcb28e23bbd948f47fd0661120556e2620c`. The actual installed source, not an assumed latest
upstream revision, is the behavioral authority for the current setup. The parent subsequently
checked the latest upstream release separately; see the version-specific findings below.
[Installed package][package] [Nix lock][lock] [Pinned upstream README][pinned-readme]

The relevant Pi 1.2.0 extension documentation and complete installed bridge README were read.
Pi's public event types describe `systemPromptOptions` as mutable and explicitly say later
handlers observe earlier mutations. Pi's prompt-customizer example demonstrates in-place
structured prompt edits. Returning an arbitrary `systemPromptOptions` object is not the event
result API; mutation is the intended route. [Pi event declarations][types]
[Pi extension documentation][extensions] [Prompt-customizer example][example]

## Newer upstream: a bridge fix exists, but it is not a drop-in update

The public fork's latest release inspected on 2026-11-15 is **0.12.1**, commit
`eaa6fb765fc3b4fe182cb91c628bba4adbfd1fbc` (released 2026-11-10). Its README still explicitly marks
`before_agent_start -> systemPrompt` as dropped. Updating the bridge alone therefore does not
repair Captain's current raw-prompt injection. It also documents support for structured custom
prompt sections. [Latest release][latest-release] [Latest compatibility table][latest-readme]

The newer release does address stale supported instructions. Its `syncSharedSession()` compares
the stored `promptDigest` with the current projected append's digest. A change selects a full
history import into a new Claude Code session, rather than ordinary resume. Its README documents
that changed instructions reach the next turn, at the cost of a cache miss and dropping earlier
thinking. This is a general bridge-side improvement, distinct from Captain choosing a supported
injection route. Dynamic task state should not unnecessarily rewrite stable system instructions
on every turn. [Latest synchronization source][latest-index]
[Latest changed-instructions behavior][latest-readme]

However, version 0.12.1 declares both Pi Coding Agent and Pi AI peer dependencies as **>=1.5.1**.
The inspected installation is Pi **1.2.0**. Do not blindly update only the bridge flake input:
that is outside the declared compatibility range. A clean upgrade path needs Pi and bridge
updates plus the Captain transport change, followed by the existing Paj/Captain/paj-rc regression
suites and bridge-specific prompt checks. No updates were performed by this research.
[Latest package requirements][latest-package] [Installed Pi extension contract][extensions]

For the existing versions, literal Captain messages remain the no-upgrade workaround described
above, with explicit mode scope and supersession. Prefer a stable structured profile and separate
current-run state where the installed bridge can honor updates reliably. Neither approach should
forward Pi's entire internal harness or claim identical context priority without verification.

## Does Pi clone options between handlers?

**No. It clones once per dispatch, not once per handler.**

`emitBeforeAgentStart()` calls `normalizeBuildSystemPromptOptions(systemPromptOptions)` before
its handler loop, creating `currentOptions`. Every handler's event contains
`systemPromptOptions: currentOptions`. A getter renders the current prompt from that same
object. The bridge assigns `lastSystemPromptOptions = event.systemPromptOptions`, keeping an
object reference. It copies selected portable fields when recording a capture, and records
again at `agent_start` and `turn_start` using that saved reference. [Pi runner][runner]
[Pi normalization][prompt] [Bridge recording hooks, lines 2155–2210][bridge]

Consequently:

| Handler order           | Observation                                                     |
| ----------------------- | --------------------------------------------------------------- |
| Captain, then bridge    | Initial bridge capture already sees the updated append.         |
| Bridge, then Captain    | Later boundary capture sees Captain's mutation through the ref. |
| Either, returning force | Final key includes Captain text; portable projection omits it.  |

The early bridge-first capture copies the old append string, but the later final-prompt capture
copies the now-updated append. That distinction explains why simply examining the first capture
would give an incorrect load-order conclusion. [Bridge recording hooks][bridge]
[Capture exact lookup and portable projection][capture]

### Existing append and repeated runs

Preserve `appendSystemPrompt` and add a separator plus only Captain-owned text; do not substitute
`event.systemPrompt`, and do not replace the whole `event.systemPromptOptions` object. A safe
future implementation should append once per handler dispatch, not once per model tool turn.
[Mutable event API][types] [Pi runner][runner]

Pi's `_prepareRun()` always passes `_baseSystemPromptOptions` to the event runner. Normalization
returns a new options object with the current append string. The run's result is stored separately
as `_runSystemPromptOptions`, then cleared after the run. Therefore mutations confined to that
run object do not append the same Captain block back into the base on the next run. Do not mutate
the base via unrelated APIs or repeatedly append at `turn_start`. Another extension can still
rewrite fields or force the whole prompt later; composition with arbitrary overrides is not
guaranteed. [Pi run preparation and cleanup][session] [Normalization][prompt]

The invalid-config branch must use the chosen supported delivery path too. Fixing only the normal
profile leaves the current "configuration invalid; do not coordinate" notice dropped by the
bridge. Tool-level permission checks should remain unchanged and must not depend on an LLM
reading a warning. [Captain hook and tools][captain]

## Why structured append is not the entire solution

The bridge README says project context, skills, and extension-written instructions are captured
on the first request and reused on resume; changes may not take effect until rebuild or
compaction. This is not just a capture-lookup issue. [Known issues][readme]

The actual `syncSharedSession()` code removes system messages from conversation history before
computing the prior-message cursor. Its reuse decision checks missed conversation messages and
a rebuild flag, not changed system-prompt contents. `toBridgeContext()` separately projects
system state into `context.systemPrompt`, removing those messages from history. A change in
Pi's structured append therefore does not itself force a Claude session rebuild. A new SDK
query receives projected append text, but this source does not establish that Claude Code
replaces a resumed session's recorded system instructions. [Session sync, lines 711–806][bridge]
[Transcript conversion][transcript] [README's measured limitation][readme]

This matters even for a static profile: enabling Captain in an existing Claude session can change
the prompt mid-session, as can `/captain off`. Dynamic summaries and reporting settings change
more often. Do not promise immediate activation/deactivation semantics from an append-only fix.
Literal custom messages are a supported way to carry current information in the conversation,
but earlier messages remain in history; mode transitions need explicit scope and supersession
wording rather than pretending old instructions disappear. [Captain command/hook][captain]
[Supported injection routes][readme]

## Comparing the alternatives

| Route                  | Benefit                       | Limitation                         |
| ---------------------- | ----------------------------- | ---------------------------------- |
| Structured append      | Portable system placement     | Resumed updates can be stale       |
| Hidden custom message  | Current-run conversation text | User-turn priority; history growth |
| Static append + state  | Stable policy and fresh state | More code; activation matters      |
| Bridge forced parsing  | Helps older extensions        | Ambiguous edits; protection risk   |

A hidden message means hidden in the UI, not secret from the model or excluded from history.
Pi collects handler-returned messages into custom conversation entries. The bridge README
explicitly reports this route reaches Claude Code as literal user-turn text.
[Pi message collection][session] [Bridge route measurements][readme]

Bridge-side suffix extraction is possible only with a defensible provenance rule. The existing
capture fallback already preserves text wrapping a known assembled prompt, but normal
`agent_start`/`turn_start` exact captures defeat that fallback for forced strings: their portable
fields omit `forceSystemPrompt`. Simply disabling exact recapture or forwarding the full forced
string would break legitimate prompt re-renders or reintroduce forbidden harness text. Capturing
known extension-owned additions structurally is preferable to guessing a prose diff.
[Capture lookup/inheritance][capture] [Bridge recapture rationale][bridge]

The bridge's rejection of Pi's preamble and a particular documentation-path pair is explicit
billing/subscription protection according to its maintainers. Selective projection is therefore
intentional; losing an extension's legitimate added instructions is a compatibility limitation,
not evidence of a Fable defect. Whether to label silent loss a bridge bug is a product/API-contract
decision; the documented limitation and available Captain-side fix do not require settling that
label first. [Rejection rationale][readme] [Projection and assertSendablePrompt][capture]

## Offline check performed

An ephemeral Node stdin fixture imported the actual installed Pi normalization/render functions
and transformed the actual bridge `prompt-capture.ts` in memory. Only empty context/skill
renderers and the unused diagnostic path were stubbed; there was no extension activation,
provider initialization, session creation, auth read, or network/model request.

Assertions passed for both hook orders:

- Existing append plus Captain's structured append survives actual capture projection.
- The equivalent Captain suffix returned as a forced whole prompt is dropped.
- A later final capture observes mutation through the saved options reference.
- Repeated independent run normalizations preserve one Captain block and leave base append intact.

The first fixture attempt used Node's strip-only TypeScript mode, which rejects parameter
properties; retrying in transform mode passed. This checks projection/object semantics only, not
Claude Code's resumed-session behavior, instruction hierarchy, or a complete Captain integration.

## Required tests before claiming a fix

1. Both extension orders, with existing custom prompt, append, context, and skills preserved.
2. Enabled, dormant, disabled, re-enabled, invalid configuration, failed refresh, and ledger errors.
3. Multiple independent runs, tool continuations, and user/custom-message-triggered runs: no
   duplicated append, stale current-run state, or unintended activation.
4. Ordinary Codex still receives Captain guidance through the chosen system/message interface.
5. A stubbed bridge request contains only the intended portable Captain text, never Pi's harness.
6. Explicit resumed-session coverage: enable/off and reporting/task changes must reach the next
   request, or the implementation must document its limitation. A query-options assertion alone
   cannot prove Claude Code changes its resumed system prompt.
7. Separate opt-in live validation later, only with user authorization; no paid calls are needed
   for the offline regression suite.

No implementation, installation, configuration change, service operation, or live model
request was performed for this research. The separate virtual-model compaction restriction is
unchanged by any of these prompt-delivery options. [Compaction implementation][compaction]

## Primary sources

Long source URLs are intentionally unwrapped.

[captain]: ../../src/extension.js
[compaction]: ../../src/compaction.js
[readme]: /home/jacob/.pi/agent/extensions/claude-agent-sdk/README.md
[package]: /home/jacob/.pi/agent/extensions/claude-agent-sdk/package.json
[lock]: /home/jacob/.nixos/flake.lock
[pinned-readme]: https://github.com/pi-pod/pi-claude-agent-sdk/blob/36a20bcb28e23bbd948f47fd0661120556e2620c/README.md
[bridge]: /home/jacob/.pi/agent/extensions/claude-agent-sdk/src/index.ts
[capture]: /home/jacob/.pi/agent/extensions/claude-agent-sdk/src/prompt-capture.ts
[transcript]: /home/jacob/.pi/agent/extensions/claude-agent-sdk/src/transcript.ts
[extensions]: /nix/store/wxhdhlgzfl4iabzxl1kxhwiyykn40ckx-pi-coding-agent-1.2.0/lib/node_modules/pi-monorepo/docs/extensions.md
[types]: /nix/store/wxhdhlgzfl4iabzxl1kxhwiyykn40ckx-pi-coding-agent-1.2.0/lib/node_modules/pi-monorepo/dist/core/extensions/types.d.ts
[runner]: /nix/store/wxhdhlgzfl4iabzxl1kxhwiyykn40ckx-pi-coding-agent-1.2.0/lib/node_modules/pi-monorepo/dist/core/extensions/runner.js
[prompt]: /nix/store/wxhdhlgzfl4iabzxl1kxhwiyykn40ckx-pi-coding-agent-1.2.0/lib/node_modules/pi-monorepo/dist/core/system-prompt.js
[session]: /nix/store/wxhdhlgzfl4iabzxl1kxhwiyykn40ckx-pi-coding-agent-1.2.0/lib/node_modules/pi-monorepo/dist/core/agent-session.js
[example]: /nix/store/wxhdhlgzfl4iabzxl1kxhwiyykn40ckx-pi-coding-agent-1.2.0/lib/node_modules/pi-monorepo/examples/extensions/prompt-customizer.ts
[latest-release]: https://github.com/pi-pod/pi-claude-agent-sdk/commit/eaa6fb765fc3b4fe182cb91c628bba4adbfd1fbc
[latest-readme]: https://github.com/pi-pod/pi-claude-agent-sdk/blob/eaa6fb765fc3b4fe182cb91c628bba4adbfd1fbc/README.md#compatibility-with-other-extensions
[latest-index]: https://github.com/pi-pod/pi-claude-agent-sdk/blob/eaa6fb765fc3b4fe182cb91c628bba4adbfd1fbc/src/index.ts#L576-L613
[latest-package]: https://github.com/pi-pod/pi-claude-agent-sdk/blob/eaa6fb765fc3b4fe182cb91c628bba4adbfd1fbc/package.json
