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

Ask Captain to find or launch agents, delegate work, inspect progress, and report results.
Workers run independently in normal tmux sessions and keep running when Captain exits.

Use `/captain status`, `/captain settings`, and `/captain tasks` to inspect state.
`/captain off` restores ordinary mode without stopping workers.

Workspace rules restrict launches, not communication. These are tool-level checks, not an OS
sandbox. Queued work is not proof of execution; uncertain actions are not automatically repeated.

### Optional voice reports

Install `paj-voice` separately to hear Captain reports; it is not a Captain dependency.
With Captain and voice enabled, the agent uses `voice_speak` for concise orchestration reports,
normally one sentence of about 30 words or fewer. Questions, blockers, and results are essential;
eyes-free mode also includes meaningful assignment/progress updates even when `reporting.progress`
is false. Detailed screen answers stay unchanged. Raw worker reports and tool narration are not
spoken automatically. Captain owns task narration; the voice addon may add a brief response-completion
notice.

The addons discover each other through Pi's versioned event bus in either load order. Turning
Captain off or replacing/shutting down its session releases its voice reporter registration.
Without a compatible voice addon, Captain remains text-only.

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
`PAJ_CAPTAIN_PAJ_EXTENSION` explicitly to test Pi/Paj; set `PAJ_CAPTAIN_VOICE_DIR` to test voice.
No sibling checkout is assumed.
