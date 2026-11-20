# paj-captain

`paj-captain` orchestrates main [Paj](https://github.com/jlodenius/paj) agents inside
[Pi](https://github.com/earendil-works/pi). Enable it in an existing session with `/captain`.

## Install

Requires Linux, Pi 1.5.2 or newer, Paj, Node.js 24 or newer, tmux, and `flock`
(the file-locking command from util-linux).

Install [Paj](https://github.com/jlodenius/paj#install) first, then the Pi package:

```sh
pi install git:github.com/jlodenius/paj-captain
```

### NixOS

For NixOS with Home Manager, add the GitHub flake input:

```nix
inputs.paj-captain.url = "github:jlodenius/paj-captain";
```

In your Home Manager user configuration, with `inputs` available in the module scope:

```nix
imports = [inputs.paj-captain.homeManagerModules.default];
programs.paj-captain.enable = true;
```

The module installs the extension, skill, tmux, and util-linux. Install Pi and Paj separately.
Rebuild NixOS and skip `pi install`; Home Manager loads the extension and skill.

## Model defaults

Captain keeps your current Pi model and thinking level. New workers use Pi's startup defaults
unless you supply a model.

Use GPT/Codex for now. Claude bridge does not receive Captain's system-prompt additions, so its
registered tools and skills alone do not provide full Captain behavior.

## Setup

Merge a `captain` section into `~/.pi/agent/paj.json` (or `paj.json` under
`PI_CODING_AGENT_DIR`). Preserve existing `subagents`, `voice`, and other sibling settings; do not
overwrite the file with this example:

```json
{
  "captain": {
    "version": 1,
    "workspaces": {
      "allow": ["~/Development/**", "~/.nixos"],
      "exclude": []
    },
    "reporting": {
      "progress": false,
      "verbosity": "brief"
    }
  }
}
```

Adjust the workspace paths to your projects. Without an allowlist, Captain can message existing
agents but cannot launch new ones. Ask Captain to change preferences, or edit its section directly.
Captain reads only its own section and preserves sibling settings when saving. For a declarative
symlink, edit the source instead. The old `captain.json` file is not read; move its contents under
`captain` in the shared file when upgrading.

Run `/reload`, then `/captain`. Restart Pi instead if you upgraded Pi itself.

## Usage

Captain coordinates rather than doing project work: it delegates to the relevant existing MAIN,
including busy agents, and launches a new main only when none exists. Each responsible main arranges
its own regular subagent reviews, resolves findings, and reports results and checks. Ordinary mains
continue to use regular subagents. Workers run independently in normal tmux sessions and keep running
when Captain exits.

With compatible Paj, Captain can observe mains and their children; it directs children through their
owning main. Captain requires Paj's `paj:captain-inspection:v1` handshake:
`{ enabled, piSessionId, reply }`. Paj replies synchronously with a registry-update promise; Captain
awaits it before activation or completing revocation. Missing or rejected permission fails closed.

Use `/captain status`, `/captain settings`, and `/captain tasks` to inspect state. The task view
shows unanswered questions, uncertain sends and replies, reported outcomes, and remaining slots
and bytes in this Pi session’s ledger. If Paj refresh fails, the view labels saved data as last
known. Use `captain_tasks` with an exact task ID for full retained details. An enqueue or a worker
report does not verify execution or success.

Task refresh requires a Paj version with `paj message read`. Upgrade all Paj participants together
and start with a new empty `PAJ_RUNTIME_DIR`; old or mixed-writer runtimes are not supported for
paged refresh. Captain reads bounded pages without acknowledging messages and saves progress
with the observations, so another refresh can continue a backlog. An incomplete read or history
gap leaves saved data last known and blocks tracked replies until refresh is verified. Older
registrations and their messages are not migrated or deleted; check them separately using Paj’s
existing history tools. A new registration is not a continuation of the old inbox, and old
assignments are not resent.

`/captain off` restores ordinary mode without stopping workers. Captain always starts OFF after
startup, resume, fork, switch, reload, or history navigation; historic mode entries never reactivate
it. Explicit `/captain` activation is required. There is no model-callable mode tool.

Workspace rules restrict launches, not communication. These are tool-level checks, not an OS
sandbox. Queued work is not proof of execution; uncertain actions are not automatically repeated.

Captain reports through ordinary Pi responses. If you use a separate Voice extension, it handles
speech according to its own settings. No Captain settings migration is needed.

## Reference

- [Captain workflow](skills/paj-captain/SKILL.md)

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
