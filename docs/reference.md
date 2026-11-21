# Captain reference

[Back to setup](../README.md).

## Model defaults

Captain keeps your current Pi model and thinking level. New workers use Pi's startup defaults
unless you supply a model.

Use GPT/Codex for now. Claude bridge does not receive Captain's system-prompt additions, so its
registered tools and skills alone do not provide full Captain behavior.

## Launch settings

Adjust the workspace paths to your projects. Without an allowlist, Captain can message existing
agents but cannot launch new ones. Ask Captain to change preferences, or edit its section directly.
Captain reads only its own section and preserves sibling settings when saving. For a declarative
symlink, edit the source instead. The old `captain.json` file is not read; move its contents under
`captain` in the shared file when upgrading.

## Inspection and task tracking

With compatible Paj, Captain can observe mains and their children; it directs children through their
owning main. Captain requires Paj's `paj:captain-inspection:v1` handshake:
`{ enabled, piSessionId, reply }`. Paj replies synchronously with a registry-update promise; Captain
awaits it before activation or completing revocation. Missing or rejected permission fails closed.

Use `/captain status`, `/captain settings`, and `/captain tasks` to inspect state. The task view
shows unanswered questions, uncertain sends and replies, reported outcomes, and remaining slots
and bytes in this Pi session’s ledger. If Paj refresh fails, the view labels saved data as last
known. Use `captain_tasks` with an exact task ID for full retained details. An enqueue or a worker
report does not verify execution or success.

Captain reads bounded pages without acknowledging messages and saves progress with the
observations, so another refresh can continue a backlog. An incomplete read or history gap
leaves saved data last known and blocks tracked replies until refresh is verified. Older
registrations and their messages are not migrated or deleted; check them separately using Paj’s
existing history tools. A new registration is not a continuation of the old inbox, and old
assignments are not resent.

## Mode lifecycle

`/captain off` restores ordinary mode without stopping workers. Captain starts OFF in a fresh Pi
process. Within that process, ON/OFF carries across reload, tree
navigation, new sessions, resume, and fork/clone. When Pi replaces the runtime, continuing ON
requires a fresh Paj inspection handshake. Tasks stay with their original Pi session, and historic
mode entries never reactivate Captain. There is no model-callable mode tool.

Workspace rules restrict launches, not communication. These are tool-level checks, not an OS
sandbox. Queued work is not proof of execution; uncertain actions are not automatically repeated.

## Erasing saved task ledgers

`/captain erase-ledgers` is an interactive maintenance command, not a model tool. It is only for
one local installation (`$PI_CODING_AGENT_DIR`) on a filesystem with working local `flock`.
Use only Captain versions that participate in ledger coordination in that directory. Older,
uncoordinated Pi or SDK runtimes sharing it are unsupported: they do not take the shared gate
lock, so that lock cannot detect or block them. If any such runtime uses this directory, quit it
and stop using it with this installation before attempting erasure. Do not replace or remove
coordination files while Pi is running.

Turn Captain off in every local Pi session and wait for in-flight work to settle. The command
previews saved ledger and known unfinished/unresolved task counts. It deletes all saved task ledgers
only after you type `ERASE ALL CAPTAIN LEDGERS` exactly and the preview still matches. If erasure
wins between two Pi runtimes during navigation, the old runtime cannot carry ON forward. It does
not stop workers, undo sends, or delete Paj messages, Pi conversations, preferences, or launch
receipts.
Already-sent outcomes will no longer be tracked. This is irreversible deletion, not secure erasure
of backups or other copies. If interrupted, some files may already be gone: new activation stays
blocked until you run the command again and confirm a fresh preview. There is no automatic resume.
Keep this installation and its parent directories stable while using Captain; do not run scripts
that write task files outside the coordinated extension. Unsafe files, uncertain writes and
oversized
scans refuse rather than guessing. Captain advises on enable when its best-effort metadata scan
finds more than 3 GiB. A partial scan may miss the threshold; nothing is erased automatically.

## Development

Maintained source is TypeScript. Installs build JavaScript in `dist` so Node can run the launcher
inside any package location; Home Manager builds the same output without npm downloads.

```sh
npm_config_cache=.cache/npm npm ci --ignore-scripts
npm run build
npm run typecheck
npm test
```

Git installs build `dist` automatically; rebuild after source changes. Optional integration tests
use isolated state and local fake providers. Set `PAJ_CAPTAIN_PI_BIN`, `PAJ_CAPTAIN_PAJ_BIN`, and
`PAJ_CAPTAIN_PAJ_EXTENSION` explicitly to test Pi/Paj. Set `PAJ_CAPTAIN_VOICE_DIR` to a Voice
source checkout with dev dependencies to test both extensions together with fake audio. The tests
use Voice's `tests/fixtures/extension.js` harness (verified against `1676208`). No sibling checkout
is assumed.
