# paj-captain

Captain delegates work to main [Paj](https://github.com/jlodenius/paj) agents and tracks assignments
in [Pi](https://github.com/earendil-works/pi). Each main manages its own subagents.

## Install

Requires Linux, Pi 1.5.2+, Node.js 24+, tmux, and `flock` (util-linux).
[Install Paj](https://github.com/jlodenius/paj#install) with Captain inspection support and
the `paj message read` and `paj message get` commands. If upgrading from before paged reads,
follow [Paj's runtime cutover](https://github.com/jlodenius/paj#read-received-messages-in-pages).
Use compatible versions for everyone sharing the runtime.

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

## Setup

Merge the section below into [the shared `paj.json`](https://github.com/jlodenius/paj#shared-settings).
Without an allowlist, Captain can delegate to existing mains but cannot launch one.
Use GPT/Codex; Claude bridge does not provide full Captain behavior.

```json
{
  "captain": {
    "version": 1,
    "workspaces": { "allow": ["~/Development/**"] }
  }
}
```

## Usage

In a main Paj-enabled Pi session, run `/reload` (restart Pi if upgraded), then `/captain`.
Check `/captain status`.
Ask Captain to have an existing main agent run a project's tests, then look for the assignment
in `/captain tasks`. Queued work is not proof of execution; *last known* means the task view
is not current. `/captain off` stops coordination, not workers.

[paj-rc](https://github.com/jlodenius/paj-rc) shows a Captain badge;
[paj-voice](https://github.com/jlodenius/paj-voice) can speak Captain's replies.

## Reference

- [Captain workflow](skills/paj-captain/SKILL.md)
- [Launch settings, mode lifecycle, ledger maintenance, and development](docs/reference.md)
