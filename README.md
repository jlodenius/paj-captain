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

Create `~/.pi/agent/captain.json` (or `captain.json` under `PI_CODING_AGENT_DIR`):

```json
{
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
```

Adjust the workspace paths to your projects. Without an allowlist, Captain can message existing
agents but cannot launch new ones. Ask Captain to change preferences, or edit this file directly.

Run `/reload`, then `/captain`. Restart Pi instead if you upgraded Pi itself.

## Usage

Ask Captain to find or launch agents, delegate work, inspect progress, and report results.
Workers run independently in normal tmux sessions and keep running when Captain exits.

Use `/captain status`, `/captain settings`, and `/captain tasks` to inspect state.
`/captain off` restores ordinary mode without stopping workers.

Workspace rules restrict launches, not communication. These are tool-level checks, not an OS
sandbox. Queued work is not proof of execution; uncertain actions are not automatically repeated.

## Reference

- [Captain workflow](skills/paj-captain/SKILL.md)
- [Compaction guidance and compatibility](docs/compaction.md)

## Development

```sh
npm test
PI_OFFLINE=1 PAJ_CAPTAIN_PI_BIN=$(command -v pi) PAJ_CAPTAIN_PAJ_BIN=$(command -v paj) npm test
```

Integration tests use isolated state and local fake model providers. They expect a sibling Paj
checkout; set `PAJ_CAPTAIN_PAJ_EXTENSION` to its extension path otherwise.
