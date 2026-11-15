# Captain model compatibility: installed Claude/GPT setup

Inspected on 2026-11-15: Captain checkout `c12aa15`, installed Captain `bb81f64`, Pi 1.2.0,
and Claude bridge 0.9.2 (`36a20bcb28e23bbd948f47fd0661120556e2620c`).

## Verdict

**Astra passes the new compaction guard. Fable also passes that guard, but the installed Claude
bridge drops Captain's injected role/profile/task-summary instructions.** Tools and skills can
still work; that is not full Captain profile compatibility. In the installed
Pi 1.2.0 catalog, `openai-codex/gpt-6-astra` is a concrete chat entry with API
`openai-codex-responses`. The bridge registers `claude-bridge/claude-fable-5` and
`claude-bridge/claude-fable-5-1` as concrete chat entries with API `claude-bridge`, not
`pi-virtual`. The configured default, `openai-codex/gpt-6.1-sol`, also uses
`openai-codex-responses`. These are source-level compatibility findings, not successful service
requests or model-quality benchmarks. [Codex catalog][codex] [Anthropic catalog][anthropic]
[Bridge registration][bridge-index] [Captain check][captain-check]

Astra and Fable are **not provider IDs** here: the providers are `openai-codex` and
`claude-bridge`. Astra is part of the exact GPT model ID above; Fable is a Claude family with two
catalog IDs. A short name alone does not establish the selected entry's API or capabilities.
[Codex catalog][codex] [Bridge model policy][bridge-models]

## Two different compatibility questions

1. **General Captain coordination:** Captain retains the session's existing model and thinking
   settings. Its normal coordination tools are not restricted to a named vendor or model family.
   A model still needs working Pi provider integration, credentials/entitlement, and usable tool
   calling to operate those tools. This is not a claim that every chat model coordinates equally
   well. The Claude bridge has a separate prompt-delivery incompatibility detailed below.
   [Captain README][captain-readme] [Captain extension][captain-extension]
2. **Guided compaction in local commit `c12aa15`:** `compactCaptain()` rejects the current selected
   model when `ctx.model.api === 'pi-virtual'`, before a summary request. It cancels compaction,
   not Captain activation or all coordination. It does not blacklist Astra, Fable, GPT, Claude, or
   custom physical APIs. A physical model passing this guard can still fail authentication,
   streaming, or summary validation. [Compaction implementation][captain-check]
   [Compatibility and failure contract][captain-compaction]

The Nix-installed Captain symlink resolves to
`/nix/store/zy2ld6jpzvsi6idpngq7ajs288f0nwcm-source`. Its `src` directory has no `compaction.js`
and its extension has no `session_before_compact` hook. Thus the local checkout's new compaction
restriction must not be presented as an existing installed-Captain failure. Whether a particular
running process loaded another extension copy was not inspected. [Installed extension][installed]

## Claude bridge: tools work, but Captain's profile is dropped

**Source-level finding:** all models served by this installed `claude-bridge` share a prompt
projection path that drops the current Captain hook's returned system-prompt additions. This
includes both Fable IDs, not just one family. This is separate from the `pi-virtual` compaction
guard. The installed Captain version also returns its profile through this same route.
[Captain hook][captain-extension] [Installed Captain hook][installed]
[Bridge capture hooks][bridge-index] [Bridge projection][capture]

The concrete flow is:

1. Captain's `before_agent_start` returns `systemPrompt: event.systemPrompt + suffix`. The suffix
   contains the Captain identity, skill-reading instruction, main-agent policy, reporting
   preferences, refresh/failure notices, and task metadata. Its invalid-configuration warning
   uses this same route. [Captain hook][captain-extension]
2. Pi's event runner stores that string as `currentOptions.forceSystemPrompt`; it does not move
   the suffix into `customPrompt` or `appendSystemPrompt`. [Pi event runner][runner]
3. The bridge stashes `event.systemPromptOptions`. Its `recordSystemPrompt()` copies only
   `customPrompt`, `appendSystemPrompt`, `contextFiles`, and `skills` into the capture. It ignores
   `forceSystemPrompt`. At `agent_start` and `turn_start`, it records the final rendered prompt
   (including Captain's suffix) as a lookup key using those original portable fields.
   [Bridge capture hooks, lines 2155–2210][bridge-index]
4. `resolveOrDerive()` returns an exact capture immediately when that final prompt is known.
   `projectPromptCapture()` then emits context files, skills, custom prompt, and appended
   instructions; it does not emit the capture's `assembledPrompt` key. The SDK request uses
   `systemPrompt: { type: 'preset', preset: 'claude_code', append: systemPromptAppend }`.
   Therefore the Captain suffix in the key is not forwarded.
   [Capture resolution/projection][capture] [SDK request setup][bridge-index]

This conclusion does not depend on Captain loading before or after the bridge's
`before_agent_start` handler: the later `agent_start`/`turn_start` recordings make the final
prompt an exact key either way. The bridge's fallback for unknown prompts that *wrap* a known
capture preserves surrounding text, but the normal exact-key path above bypasses that fallback.
It is not a rescue for Captain's current hook. The bridge README independently documents
`before_agent_start -> systemPrompt` as dropped. [Capture implementation][capture]
[Bridge compatibility table][bridge-readme]

**Practical verdict:** Fable and the other bridge models are usable as Pi chat/tool providers,
but should not currently be claimed fully compatible with Captain's dynamic profile delivery.
The tools remain registered, and the bridge separately forwards skills/project context; a model
may still coordinate using those sources or explicit user instructions. That does not restore
missing per-turn profile text, task-summary freshness warnings, or configuration-error guidance.
Astra through `openai-codex` does not use this bridge projection path. This is a transport/source
finding, not an observed live model failure. [Captain registration][captain-extension]
[Bridge model-independent request setup][bridge-index]

**Smallest safe fix suggestion, not implemented:** deliver only Captain's additional text as a
`before_agent_start` custom `message` (with the normal hidden-display option), rather than
returning a replacement `systemPrompt` containing Pi's whole assembled prompt. Include the
invalid-configuration branch. This is the bridge's documented literal-text route and avoids
forwarding Pi's harness wholesale. Keep Captain's tool-level policy checks; message delivery is
not a substitute for them. Validate offline message presence, enabled/off behavior, invalid-config
handling, and repeated-turn behavior, then separately verify an actual bridge request before
claiming full compatibility. This changes instruction placement from system to message and
therefore is not a promise of identical model behavior. [Supported injection routes][bridge-readme]
[Pi message collection][runner]

## What actually would be rejected?

A **Pi virtual selection**, regardless of its name or provider namespace. Pi creates these entries
with `api: 'pi-virtual'`. An extension can register one beside physical models, including under
`openai-codex`; it can even hide a same-ID physical entry. Consequently, a provider wildcard or
familiar model name does not prove the current runtime entry is physical.
[Virtual API implementation][virtual-source] [Virtual-model contract][virtual-doc]

Pi's native compaction resolves a virtual selection against the session conversation first.
Captain's new registry-stream adapter cannot preserve that routing contract, so it intentionally
fails closed. Select a concrete physical entry before compacting, or `/captain off` to use stock
compaction. This is a limitation of the new adapter, not evidence that the routed underlying GPT
or Claude cannot coordinate. [Captain compatibility notes][captain-compaction]
[Pi native summary routing][session-source]

A catalog entry's provider-side implementation or fallback behavior is a separate question from
Pi virtual routing. Calling Astra or Fable a Pi router based on its marketing name, or on catalog
fallback metadata, would not establish `api: 'pi-virtual'`.
[Virtual API implementation][virtual-source]

## Exact relevant catalog IDs

Read directly from installed JSON; no network refresh or model request was made. These are
**bundled catalog entries**, not a server-confirmed list of account entitlements. Pi can overlay
newer catalog data, and extensions can change the runtime registry.
[Model selection docs][model-doc]

### `openai-codex` — API `openai-codex-responses`

Every entry below is a chat model in the installed Codex catalog. Prefix each with
`openai-codex/` for its full selection ID. [Codex catalog][codex]

- `gpt-5.3-codex-spark`
- `gpt-5.5`
- `gpt-5.6-luna`
- `gpt-5.6-sol`
- `gpt-5.6-terra`
- `gpt-6-astra`
- `gpt-6-luna`
- `gpt-6-sol`
- `gpt-6.1-sol`

### `claude-bridge` — API `claude-bridge`

The installed bridge builds its models from Pi AI's `anthropic` catalog, removes dated aliases,
and registers the resulting definitions under `claude-bridge` with its own streaming API.
Pi's extension loader aliases the Pi AI import to the installed compatibility entrypoint; the
bridge does not contain a separate hardcoded list of available families.
[Bridge model policy][bridge-models] [Bridge registration][bridge-index]
[Pi extension loader][loader]

The installed catalog therefore supplies these bare IDs. Prefix each with `claude-bridge/`.
The original `anthropic` entries use `anthropic-messages`; **the bridge selections do not**.
[Anthropic catalog][anthropic] [Bridge registration][bridge-index]

- `claude-fable-5`
- `claude-fable-5-1`
- `claude-haiku-4-5`
- `claude-haiku-5-5`
- `claude-opus-4-5`
- `claude-opus-4-6`
- `claude-opus-4-7`
- `claude-opus-4-8`
- `claude-opus-5`
- `claude-opus-5-5`
- `claude-sonnet-4-5`
- `claude-sonnet-4-6`
- `claude-sonnet-5`
- `claude-sonnet-5-5`

The bridge omits the dated IDs `claude-haiku-4-5-20251001`,
`claude-opus-4-5-20251101`, and `claude-sonnet-4-5-20250929` present in the underlying catalog.
[Anthropic catalog][anthropic] [Bridge alias filter][bridge-models]

## Configuration and Fable-specific caveats

A selective read of the local settings confirmed `defaultProvider: openai-codex`,
`defaultModel: gpt-6.1-sol`, and `enabledModels: [openai-codex/*, claude-bridge/*]`.
These patterns govern startup selection/model cycling, not subscription access or an API
compatibility guarantee. No credential values were inspected or recorded.
[Settings contract][settings-doc]

Fable is explicitly handled by the installed bridge:

- Both Fable IDs use always-on adaptive thinking; the bridge requests summarized thinking display.
- Fable 5.1 thinking signatures are treated as conversation-prefix-bound on history rebuild.
- Fable 5.1 requires Claude Code `2.1.251` or newer according to the bridge's guard. The installed
  SDK package declares bundled Claude Code `2.1.285`, above that minimum. The parent separately
  checked the explicitly configured executable with `--version`: it reports `2.1.296`, also above
  the minimum. This was a version check, not a model request.
- The bridge's measured policy requests `[1m]` for these Fable IDs unless overridden. This suffix
  is a Claude Code request ID, not another Pi model-picker ID. Its source also records that Fable 5
  is not included on Pro without Extra Usage. Treat that as the bridge maintainer's recorded
  observation, not independently verified current account entitlement. The local bridge declares
  `provider.plan: "pro"` and `longContextExtraUsage: false`; these local settings do not establish
  the actual subscription tier or account-level Extra Usage setting.

[Bridge model policy and observations][bridge-models] [Bridge stream setup][bridge-index]
[Executable guard][executable] [Installed SDK metadata][sdk-package]

## Evidence limits and practical answer

**Astra and both Fable IDs pass the new physical-model compaction guard. However, all listed
Claude bridge models lose Captain's current dynamic system-prompt suffix on the normal bridge
capture path.** Tools/skills availability, full role/profile delivery, and guided compaction are
three distinct compatibility questions. These are inferences from the cited source, not an
end-to-end certification. A Pi virtual override changes the compaction answer as well.

No model calls, authentication refresh, live registry inspection, package changes, service changes,
or configuration changes were performed. No claim is made about account availability, real-world
coordination reliability, instruction following, cost effectiveness, or semantic summary quality.
The compaction documentation also notes that private host stream wrappers/provider lifecycle hooks
are not reproduced; custom integration combinations need separate validation.
[Compaction limitations][captain-compaction]

## Primary sources

Local immutable installation paths identify the exact inspected build, rather than assuming that
upstream `main` matches it. Long source URLs below are intentionally unwrapped.

[captain-readme]: ../../README.md
[captain-extension]: ../../src/extension.js
[captain-check]: ../../src/compaction.js
[captain-compaction]: ../compaction.md
[installed]: /nix/store/zy2ld6jpzvsi6idpngq7ajs288f0nwcm-source/src/extension.js
[codex]: /nix/store/wxhdhlgzfl4iabzxl1kxhwiyykn40ckx-pi-coding-agent-1.2.0/lib/node_modules/pi-monorepo/node_modules/@earendil-works/pi-ai/dist/providers/data/openai-codex.json
[anthropic]: /nix/store/wxhdhlgzfl4iabzxl1kxhwiyykn40ckx-pi-coding-agent-1.2.0/lib/node_modules/pi-monorepo/node_modules/@earendil-works/pi-ai/dist/providers/data/anthropic.json
[virtual-doc]: /nix/store/wxhdhlgzfl4iabzxl1kxhwiyykn40ckx-pi-coding-agent-1.2.0/lib/node_modules/pi-monorepo/docs/virtual-models.md
[virtual-source]: /nix/store/wxhdhlgzfl4iabzxl1kxhwiyykn40ckx-pi-coding-agent-1.2.0/lib/node_modules/pi-monorepo/dist/core/virtual-models.js
[session-source]: /nix/store/wxhdhlgzfl4iabzxl1kxhwiyykn40ckx-pi-coding-agent-1.2.0/lib/node_modules/pi-monorepo/dist/core/agent-session.js
[loader]: /nix/store/wxhdhlgzfl4iabzxl1kxhwiyykn40ckx-pi-coding-agent-1.2.0/lib/node_modules/pi-monorepo/dist/core/extensions/loader.js
[model-doc]: /nix/store/wxhdhlgzfl4iabzxl1kxhwiyykn40ckx-pi-coding-agent-1.2.0/lib/node_modules/pi-monorepo/docs/models.md
[settings-doc]: /nix/store/wxhdhlgzfl4iabzxl1kxhwiyykn40ckx-pi-coding-agent-1.2.0/lib/node_modules/pi-monorepo/docs/settings.md
[bridge-models]: /home/jacob/.pi/agent/extensions/claude-agent-sdk/src/models.ts
[bridge-index]: /home/jacob/.pi/agent/extensions/claude-agent-sdk/src/index.ts
[executable]: /home/jacob/.pi/agent/extensions/claude-agent-sdk/src/claude-executable.ts
[sdk-package]: /home/jacob/.pi/agent/extensions/claude-agent-sdk/node_modules/@anthropic-ai/claude-agent-sdk/package.json
[capture]: /home/jacob/.pi/agent/extensions/claude-agent-sdk/src/prompt-capture.ts
[bridge-readme]: https://github.com/pi-pod/pi-claude-agent-sdk/blob/36a20bcb28e23bbd948f47fd0661120556e2620c/README.md#which-injection-routes-reach-claude-code
[runner]: /nix/store/wxhdhlgzfl4iabzxl1kxhwiyykn40ckx-pi-coding-agent-1.2.0/lib/node_modules/pi-monorepo/dist/core/extensions/runner.js
