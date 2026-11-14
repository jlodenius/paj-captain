# paj-captain and paj-voice: design proposal

## Status and selected names

The user selected `paj-captain` for the text coordinator and `paj-voice` for standalone voice.
Both projects depend on Paj/Pi; neither requires the other. The user subsequently approved starting
text-only Captain, implemented in `/home/jacob/Development/paj-captain` and published at
https://github.com/jlodenius/paj-captain. Its flake exports an optional Home Manager module.
Voice remains unimplemented; Captain preferences remain separate from package installation.

Text implementation uses a Pi extension, `/captain` activation, one workflow skill, private per-Pi
session assignment storage, independent normal-tmux launches, and configurable reporting/workspaces.
Linux util-linux `flock` provides crash-released transaction locking. Automated checks exercise real
Pi activation/reload/session replacement, isolated Paj messaging, isolated tmux, and crash recovery.

A manual Captain-to-main-agent delegation and correlated result roundtrip also succeeded. Shared
read-only `inspect_agent` is published in Paj, with conditional Captain integration. Updated Paj
must be loaded in both caller and target. Tests cover actual Pi idle/busy streaming inspection and
owned-subagent access without additional target model turns or conversation mutation.

Two independent GPT 6.1 sol reviews (medium and max thinking) found no substantive issues in the
initial proposal. The later standalone voice separation and confirmed settings below have not
received another independent review.

The user approved the architectural direction below. Implementation details and proposed defaults
remain proposals where identified. Independent reviews should report concrete correctness,
integration, security, or user-experience problems, not speculative additions or style preferences.

## Goals

Provide a normal Pi agent specialised in coordinating existing MAIN Paj agents across workspaces.
The coordinator accepts ordinary text, interprets requests, clarifies ambiguity, prepares actionable
assignments, delegates them through Paj, receives questions and results, and reports to the user.
It can launch independent main agents in explicitly allowed workspaces.

A separately installable voice addon enables a user away from the keyboard to converse with any
selected main Paj-enabled Pi agent through a headset, including speech input and output. Captain
is one possible target, not a prerequisite. Phone voice through paj-rc is a later extension.

## Confirmed user requirements

- Main agents are delegation targets. Their individual subagents are not coordinator targets.
- Each main agent remains responsible for its own implementation and subagent decisions.
- Multiple coordinators are allowed. Do not introduce singleton enforcement or global ownership.
- Clear requests may be acted on immediately, including launching agents and delegating work.
- Behave like a normal agent with a clear set of functions and skills for common use cases.
- Voice activation must support a configurable wake phrase, selectable push-to-talk button, and
  completely open conversation. Runtime switching is desirable.
- Local recognition and synthesis only initially. Local speech model downloads are approved.
  Cloud providers are future candidates, not part of the initial implementation.
- Begin with English. Configure recognition languages as an array, initially `["en"]`, allowing
  future combinations such as `["en", "sv"]`.
- Workspace allowlists are configurable and accept globs. The user's initial options are
  `~/Development/**` and `~/.nixos`. They restrict launches, not communication with existing agents.
- Enforce workspace rules through Captain's supported launch tool, not an OS sandbox.
- Activate Captain using `/captain` inside an existing Pi session, entirely in the Captain addon;
  no separate Captain launcher CLI.
- Launch independent main agents in separate attachable sessions on the normal tmux default server.
  No private Paj tmux server, extra worktrees, or project copies. Workers survive Captain exiting.
- Reporting timing, detail, and spoken behaviour will need adjustment through real-world use.
- Keep Captain and voice in separate projects; minimise changes to original Paj.
- Voice works with ordinary main Paj agents without Captain installed; Captain works without voice.
- Initially test the user's Sony Bluetooth headset on Framework, but keep device selection and
  implementation generic. The exact headset model still needs identifying for hardware testing.
- Begin with text-only Captain.

## Existing ecosystem and constraints

Repositories currently live at:

- `/home/jacob/Development/paj`: Rust CLI, Pi extension, discovery, messaging, and owned subagents.
- `/home/jacob/Development/paj-rc`: separate remote-control daemon and browser/PWA Pi addon.
- `/home/jacob/Development/paj.nvim`: existing editor integration, not to be modified for this work.

Paj provides live identities, main/subagent information, idle/busy state, project resolution,
and correlated request/question/answer/update/result messaging with archived history. A transport
acknowledgement is not proof that an agent read, started, or completed a task. Busy Pi sessions can
retain messages until idle. Existing subagent spawning is for owned children; it must not be reused
unchanged to misrepresent independent main agents.

The installed Paj communication skill requires finite assignments, one owner per assignment,
explicit completion conditions, and replies correlated to their originating request. Results and
updates do not require receipt messages. Child completion has specialised ownership semantics;
main-agent result reporting must not rely on the child-only completion tool.

paj-rc currently exposes eligible main Pi sessions, not subagents. It has its own private session
attachment, input admission, streaming, image input, and authentication. Its public Pi input method
returns void and does not itself guarantee acceptance. Avoid assuming reliable acceptance or
exactly-once model execution merely because input was dispatched.

Linux/systemd is an acceptable first environment. NixOS packaging is useful, but installation
without Nix must remain viable. Preserve existing live sessions and private Tailscale configuration.

## Project separation

### Paj: general discovery, communication, and inspection

Keep identities, discovery, message transport, session activity, and shared read-only agent
inspection in Paj. Keep workspace launch policy, reporting preferences, and speech dependencies in
the addons that own them.

The initial text Captain required no Paj changes. Shared `inspect_agent` now belongs to Paj:
agents can inspect their own subagents, and Captain can inspect main agents. It requires neither
Captain nor paj-rc and adds no Rust CLI or editor-bridge changes.

An optional session profile/capability may be preferable to adding a new top-level role: a
coordinator remains a main agent rather than a third hierarchy level. The user will accept small
changes, including an orchestrator type if justified, but prefers strong addon separation.

### paj-captain: text coordinator

Own these capabilities:

- `/captain` command that activates the profile, tools, and skills in the current main Pi session.
  Installing the addon leaves ordinary sessions dormant; `/captain off` restores normal mode.
- Main-agent discovery and exact-target resolution across workspaces.
- Independent main-agent launch within allowed workspaces.
- Workspace launch-policy configuration and enforcement in managed launches.
- Delegation using existing Paj messaging and correlation.
- A small durable activity ledger connecting user requests, assignments, targets, questions, and
  final reports, separate from the worker's general idle/busy state.
- Request refinement that preserves the user's actual intent, constraints, and completion condition.
- Text responses, user-facing announcements, and reporting preferences.
- Main-agent progress inspection through Paj's `inspect_agent`, rather than a separate
  Captain-only inspection tool or terminal-scraping implementation.
- Optional richer user-facing announcements for voice and later remote interaction, without
  making Captain the owner or prerequisite of generic voice attachment.

Install this project alone to get the complete orchestration workflow through normal Pi text input.
It must not depend on speech libraries, downloaded speech models, or cloud speech credentials.

Launched main agents are independent. Stopping a coordinator must not automatically stop them.
They register through normal Paj mechanisms and remain accessible through ordinary Pi/Paj tooling.
Host them in separate sessions on the normal tmux default server and provide attachment commands.
Define launch acknowledgement and recovery without importing owned-subagent lifecycle management.

### paj-voice: independent speech addon

Own these capabilities:

- Audio device selection, capture, playback, and Bluetooth integration.
- Wake detection, push-to-talk, open-conversation mode, and mode changes.
- Speech recognition, speech synthesis, turn detection, and speech interruption.
- Language and output-voice preferences, local speech model configuration, and downloads.
- Spoken-response scheduling; optional richer announcements supplied by Captain when present.
- Attachment to an explicitly selected main Paj-enabled Pi session, not just Captain.

It submits recognised text and speaks appropriate responses from that session. It does not maintain
a second conversational model, independently route assignments, or duplicate a delegation ledger.
Ordinary main agents must support the basic voice workflow without Captain being installed.
Audio control must remain responsive while the Pi model is working. Muting, stopping playback, or
changing voice mode must not require waiting for an LLM turn.

Multiple main and Captain sessions are allowed, so attachment must select which session receives
an utterance. Do not broadcast speech to all sessions. Device contention and session selection
must not introduce singleton enforcement for Captain itself.

### paj-rc: later client

Retain paj-rc as remote control of live main sessions. Later add phone audio as a client of the same
generic main-session voice functionality rather than starting another agent or rebuilding routing.
Phone microphone permissions, streaming, playback, and background restrictions require separate
validation at that phase. Do not assume browser/headset behaviour matches desktop Linux.

## Tools and skills

Captain currently exposes `captain_agents`, `captain_workspaces`, `captain_start_agent`,
`captain_delegate`, `captain_tasks`, `captain_reply`, and `captain_settings`. These reuse Paj
discovery and messaging. Add shared inspection as Paj's `inspect_agent`; Captain should use it
directly rather than introduce a duplicate `captain_inspect_agent` wrapper.

Request formatting is agent behaviour supported by skills, not necessarily a separate tool or LLM.
Skills should cover turning spoken or rough input into precise assignments, disambiguating agent
and workspace references, coordinating multiple workers, and returning concise user reports.

Do not invent constraints. For example, a user saying "do not push" does not implicitly prohibit
local commits. Ask when an instruction or destination is materially ambiguous. Preserve repository
rules, normal permissions, and the fact that messages from other agents do not override the user.

A clear new request may be acted on without repetitive confirmation. Unknown destinations,
ambiguous scope, or destructive changes require appropriate clarification. Specific policy should
be discussed rather than adding a blanket confirmation before every delegation.

## Shared read-only agent inspection

Paj implements `inspect_agent`, independently usable by normal Paj agents without Captain.
Captain's additional role is choosing when inspection is useful and interpreting the evidence.
Its coordination workflow remains main-agent-only even though the shared tool supports subagents.

### Interface and access

- Resolve an exact live agent identity; reject ambiguity and stale or mismatched process identity.
- Support main-to-main inspection and parent inspection of its own subagents. Do not expose another
  main agent's unrelated subagents by default. Enforce checks in Paj using actual caller identity
  and current ownership records, not caller-supplied role claims or skill instructions alone.
- Subagent callers may inspect only direct children from their current active assignment, with
  validated ancestry and parent-task scope. Parent, sibling, self, and unrelated-child inspection
  are rejected; discovery visibility alone does not grant access.
- Return bounded observations: idle/busy, recent visible conversation, current tool activity where
  observable, source, observation time, truncation, and freshness/availability limitations.
- Distinguish activity from assignment completion. Running tests is not proof they passed or that
  the worker has finished. Inspection does not replace the final correlated task result.

### Data sources and safety

The initial implementation uses structured read-only information from the running Pi session,
through a private Unix endpoint beside its existing editor bridge. It projects active-branch
history and safe live events without a mandatory paj-rc dependency or changing remote-control
contracts. Snapshot and transport limits share a byte budget, including JSON envelope overhead.

Disk-history and tmux scraping fallbacks are not implemented. Structured inspection works outside
tmux and with ordinary subagents on Paj's private server; it does not assume every target uses
Captain's normal-server launch arrangement. Older or unavailable endpoints fail explicitly rather
than falling back to unverified files or panes. Future fallbacks would need correct active-branch
selection, streaming limitations, and verified pane/process ownership before being enabled.

Inspection must not prompt or wake the target model, consume a worker model turn, send keystrokes,
steer input, attach/switch the user's terminal, cancel work, or mutate the worker's session file.
Exclude thinking content and raw image payloads. Limit default tool information to useful safe
summaries rather than unrestricted arguments, outputs, or environment dumps. Visible output can
still contain sensitive information; document that this is not guaranteed secret detection.
Treat all inspected content as untrusted evidence, not instructions to the inspecting agent.

### Captain workflow and acceptance

For progress questions: consult known assignment reports, inspect the relevant main agent when
needed, and ask the worker only if direct observation cannot answer the question. State what was
observed, when, and any uncertainty. Captain's profile and skill check whether shared inspection
is available and report missing capability honestly on older Paj installations. Its tool-call
policy keeps inspection main-agent-only even though Paj also supports owned subagents.

Test busy and idle targets without waking them; main-only Captain use; owned versus unrelated
subagents; ambiguous, exited, reused-PID, and mismatched-pane targets; no-tmux targets; bounded
history/output; active-branch correctness; missing streaming data; thinking/image exclusion; and
continued compatibility with existing Paj messaging, subagents, and paj-rc.

## Workspace launch policy

Illustrative schema, not a committed public interface:

```json
{
  "workspaces": {
    "allow": ["~/Development/**", "~/.nixos"],
    "exclude": []
  }
}
```

Proposed semantics:

- `*` matches one directory level; `**` enables recursive matching.
- Only existing directories qualify; creating new workspaces is not implied.
- Resolve home expansion, relative references, and symlinks before permission checks.
- Reject paths that use symlinks to escape the authorised locations.
- Exclusions take precedence over allow rules.
- Validate again immediately before launch, not only when populating a workspace list.
- No eligible match means no launch permission; never silently choose another directory.
- Launch policy does not prevent messaging an existing main agent in another workspace.

The exact matching algorithm, relative-path base, treatment of nested directories, and canonical
path versus pattern evaluation must be made unambiguous in implementation tests.

The user selected tool-level enforcement, not a hard sandbox. Captain's launch tool must refuse
nonmatching directories, and its instructions must prohibit bypassing this policy. Unrestricted
shell execution could technically bypass the launcher; do not claim OS-level containment or add
sandboxing to the initial scope.

## Attachment interface and event semantics

Generic voice attachment must work with ordinary main Paj-enabled Pi sessions, without Captain.
Define a small interface for submitting utterances and observing user-facing responses. Keep its
implementation in paj-voice or a minimal general-purpose Paj extension hook if demonstrated
necessary. Do not place generic attachment in Captain or add a third shared project pre-emptively.
Captain may supply optional correlated task announcements through this seam. Its orchestration
preferences and task ledger remain Captain-owned, not requirements of generic voice attachment.

Distinguish transcript/tool content from user-facing announcements. Never speak internal reasoning,
raw tool output, or entire worker reports merely because they appeared in a session stream.
The selected agent produces a response; text displays it and voice optionally speaks it.
No untrusted worker output can directly issue audio-control or coordinator tool commands.

Inputs and events need stable session/assignment correlation. Deduplication and recovery must not
promise exactly-once LLM execution or exactly-once audible delivery across crashes. Preserve user
work across audio disconnection; do not automatically resubmit an uncertain instruction.

Choose a concrete authenticated local attachment mechanism during design. Do not add public
listeners, silently change Tailscale routes, or make the optional addon mandatory for text.
Keep the seam narrow enough for voice now and a real remote client later, without building a
hypothetical general plugin platform.

## Activity tracking and reporting

Track user request -> exact main-session target -> assignment/Paj messages -> progress/questions ->
final report. A worker can be busy for another reason or idle while a delegated task is blocked.
Keep transport acceptance, worker start, completion, failure, and unknown state distinct where
observable. Do not manufacture positive worker acknowledgements from transport status.

Use incoming Paj questions and results rather than repeatedly prompting busy workers for status.
For a status question, first consult known activity and state freshness, then use Paj's
read-only `inspect_agent` for additional evidence. Ask the worker only when inspection cannot
answer the question. Multiple coordinators need independent assignment ownership and reply
routing; this does not grant exclusive ownership of a main agent or its workspace.

Proposed reporting defaults, adjustable through use:

- Brief acknowledgement that a delegation was submitted, using truthful delivery language.
- Speak relevant questions and blockers promptly, without talking over the user.
- Announce final results concisely, identifying the worker/workspace.
- Keep routine progress silent unless requested or enabled.
- Retain detailed reports in text and allow "tell me more".
- Distinguish "stop speaking" from cancelling or interrupting worker execution.
- Preserve pending reports across an audio disconnect and define replay behaviour explicitly.

Reporting preferences cover event categories, verbosity, interruption/scheduling, and text versus
speech. Persist explicit settings changes through supported configuration rather than relying on
model context surviving forever. Decide how per-session overrides relate to saved defaults.

## Voice configuration and interaction

Support wake phrase, push-to-talk (hold and optionally toggle), and open conversation. Also support
explicit microphone/output selection, silence/end-of-turn timing, activation feedback, muting, and
playback interruption. Do not confuse voice activity detection with robust semantic turn detection.
The pipeline must avoid interpreting its own TTS output as new user instructions.

Language example:

```json
{
  "languages": ["en"],
  "responseLanguage": "en"
}
```

The array denotes allowed recognition languages, not automatic support for arbitrary languages.
Later `["en", "sv"]` is desired. A separate response-language preference avoids ambiguity about
speech output. Validate provider/model capability; reject unsupported language combinations rather
than silently ignoring entries. Decide language switching and mixed-language recognition when
multilingual support is actually added.

Wake phrase example "paj" is user intent, not an available pretrained model guarantee. Pronunciation
and false activations need evaluation. A longer optional phrase such as "hey paj" may work better.
A custom detector may require training. openWakeWord's documented English focus is relevant.

Push-to-talk selection needs actual OS integration, not just a config string. Wayland compositor
shortcuts and Bluetooth headset controls have different capabilities and may not expose the desired
press/release events. Validate the actual headset and desktop environment early.

Bluetooth microphone capture can alter the headset's audio profile and playback quality. Measure
recognition accuracy, latency, playback, and interruption with the user's real hardware.

## Speech provider options

Use a text-first pipeline so the selected agent's normal Pi model remains the conversational model.
Recognition and synthesis are independently selectable. These are candidates, not benchmark
conclusions. Only local recognition/synthesis are in initial scope; cloud options below are retained
as future reference, not a requirement to build provider integrations now.

Recognition families:

- Local Whisper through whisper.cpp: CPU inference and several acceleration options.
- Local faster-whisper: quantised CPU/GPU inference using CTranslate2 and Python.
- Local streaming recognisers, including sherpa-onnx models: potentially better incremental input,
  with model/language/hardware trade-offs to measure.
- Cloud transcription, including OpenAI, Deepgram, and Azure: managed processing/streaming, with
  network, latency, privacy, account, and cost considerations.
- Native speech-to-speech/realtime models: a future alternative, not the recommended first design;
  introducing a second conversational model would undermine the single Pi conversation approach.

Synthesis candidates:

- Local Piper, using the maintained OHF-Voice project and individually checked voice licences.
- Local Kokoro, subject to language, runtime, voice, and hardware evaluation.
- Cloud TTS providers where voice quality, language coverage, or latency justify the privacy/cost.

Recommended initial evaluation: local Whisper recognition and local Piper/Kokoro synthesis.
Benchmark before selecting exact models. Do not claim Whisper windowed transcription is inherently
full-duplex conversational streaming. Models may require separate downloads and resource budgets.

Never silently fall back from local to cloud. Make data handling explicit: local speech recognition
still sends the resulting transcript to whatever model provider the Pi agent uses. Wake listening,
raw audio retention, transcripts, report logs, and speech-provider credentials need explicit privacy
and retention defaults. Propose no raw audio retention by default and no microphone capture until
voice is explicitly enabled.

Sources checked during discussion:

- https://github.com/ggml-org/whisper.cpp
- https://github.com/SYSTRAN/faster-whisper
- https://github.com/k2-fsa/sherpa-onnx
- https://github.com/dscripka/openWakeWord
- https://github.com/OHF-Voice/piper1-gpl
- https://huggingface.co/hexgrad/Kokoro-82M
- https://developers.openai.com/api/docs/guides/speech-to-text
- https://developers.deepgram.com/docs/flux/quickstart
- https://learn.microsoft.com/en-us/azure/ai-services/speech-service/overview

These sources establish candidates/capabilities, not actual laptop/headset performance or a promise
that every listed provider supports every mode and language combination.

## Delivery sequence and acceptance goals

### Confirmed before implementation

Names, `/captain` activation, tool-level launch enforcement, normal tmux hosting, initial workspace
options, and local-only speech are confirmed. Initial design reviews found no substantive issues.
Text-only implementation is approved. Define the generic main-agent voice attachment seam before
building voice; it is not a prerequisite for completing text-only Captain.

### Phase 1: text coordinator

Install and launch through ordinary Pi. Discover and target main agents only, launch independent
main agents in allowed existing workspaces, delegate finite assignments, receive correlated
questions/results, inspect known task status, and persist reporting preferences/activity.

Acceptance cases should include ambiguous names, denied/empty/excluded workspace matches, symlink
escapes, failed launch, delayed Paj registration, busy workers, worker exit, multiple coordinators,
late results, retries, and coordinator exit without stopping launched main agents.

### Phase 1b: shared Paj inspection

Implemented locally: shared `inspect_agent` in Paj and conditional Captain guidance/main-only
checks. Captain retains its own ledger and orchestration policy. Ordinary agents can use the same
tool for their direct owned subagents; neither addon is required by Paj inspection.

Tests exercise actual Pi active-branch snapshots, idle and busy streaming states, owned-child
access, denied cross-owner/child-parent access, and no extra target model turns or session writes.
Unit checks cover privacy projection, identity/scope changes, socket lifecycle, path/byte limits,
timeouts, and aborts. Existing Paj messaging and paj-rc compatibility checks remain passing.
Install through the published GitHub flakes and reload caller/worker Paj extensions for manual
user trials. The Captain Home Manager module installs resources without replacing captain.json.

### Phase 2: voice foundation

Deliver separately installable speech input/output with device selection and push-to-talk. Check
headset capture/playback early, model downloads, installation, latency, provider errors, and
transcript correction behaviour. Prove Captain works without voice and voice works with a normal
main Paj agent without Captain installed. Test generic audio device selection, not headset-specific
hardcoded behaviour.

### Phase 3: hands-free use

Add wake phrase and open conversation, interruption, reliable activation/deactivation, echo
handling, and notification scheduling. Tune report timing and verbosity through actual use.

Acceptance cases include false activations, long pauses, device loss, output interruption while
workers continue, repeated results, unsupported language/provider settings, and no silent cloud
fallback. All three user-requested modes are required for the planned base headset experience,
although push-to-talk may be delivered first as an incremental milestone.

### Phase 4: paj-rc voice

Add phone audio capture/playback as a client of the established main-agent voice seam, respecting
existing authentication, private networking, and remote-session identity rules. Evaluate browser
limitations separately. Do not implement this phase as part of the first text/headset delivery.

## Not selected yet

- Wake-phrase text/pronunciation for generic voice use and Captain-specific preferences.
- Real-user trial of launch/trust prompts, request refinement, and reporting preferences.
- Whether future coordinator discovery needs extra metadata beyond ordinary main-agent identity.
- Whether later inspection needs disk or verified tmux fallbacks beyond the structured live source;
  wider access than main-to-main/direct-owned inspection would require a separate policy decision.
- Concrete local attachment transport and its authentication.
- Exact speech models/providers, device bindings, language identifiers, and model distribution.
- Detailed task-state reconciliation and report replay rules.
- Default versus per-session configuration precedence and activity retention.

These require deliberate choices or small validation exercises, not speculative implementation of
all possible options. No source repositories or live configuration are changed by this document.
