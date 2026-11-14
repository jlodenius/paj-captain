# paj-captain

Text-first coordination of main [Paj](https://github.com/jlodenius/paj) agents inside Pi.
Enable Captain in an existing session with `/captain`; ordinary sessions stay unchanged.

## Installation

Requires Pi 1.2.0 or newer, Paj, Node.js 24 or newer, tmux, and `flock` (util-linux) on Linux.
Tested with tmux 3.7c.

For this local development checkout:

```sh
pi install /path/to/paj-captain
```

Configure `~/.pi/agent/captain.json` (or `PI_CODING_AGENT_DIR/captain.json`):

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

Run `/reload`, then `/captain`. Without workspace configuration, Captain can communicate with
existing main agents but cannot launch new ones. The current session must have a live main Paj
identity. Captain retains its existing Pi model and thinking settings.

## Use

Ask Captain to find an agent, launch one in a workspace, delegate work, answer a worker's question,
or report assignment status. Assignments retain their target, original instructions, and observed
questions and results in a private per-session ledger. When updated Paj provides `inspect_agent`,
Captain can read main-agent progress without prompting the worker.

- `/captain` enables Captain in this session.
- `/captain off` restores ordinary mode; workers keep running.
- `/captain status`, `/captain settings`, and `/captain tasks` inspect state.
- Ask Captain to change workspace or reporting options explicitly, or edit the config file.

New main agents use existing directories in separate sessions on the **normal tmux default server**,
visible with `tmux list-sessions`. Launch results include an attachment command. They are not owned
subagents, use no private Paj server, and survive Captain exiting. A startup or project-trust prompt
may require attachment before the new agent becomes available through Paj.

Workspace rules restrict launches, not communication with existing main agents elsewhere. `*`
matches one directory level and `**` matches recursively; exclusions win. Use `path/**` to exclude
an entire subtree. Permission is checked
again at launch, including symlink resolution. This is tool-level policy, **not an OS sandbox**.

Queued delivery is not proof that a worker started. Uncertain deliveries are retained without
automatic retry. Reloading or navigating session history does not undo real launches or assignments.
The ledger preserves last-known state; it is not a guarantee that Paj can deliver replies to an
identity that has disappeared. No worker is stopped automatically.

Storage is bounded to 128 assignments per Captain session and 64 retained questions per assignment.
Question overflow is flagged; completed results remain processable even after progress saturation.

## Separation

Captain reuses Paj discovery, messaging, and optional shared inspection. Inspection requires the
updated Paj extension in both caller and target; older installations retain messaging-only status.
Captain adds no voice dependencies, audio capture, public
listeners, background daemon, or changes to paj.nvim. Independent `paj-voice` and phone voice
through paj-rc are later projects.

## Development

```sh
npm test
PAJ_CAPTAIN_PI_BIN=$(command -v pi) PAJ_CAPTAIN_PAJ_BIN=$(command -v paj) npm test
```

The real-Pi checks expect a sibling Paj checkout; set `PAJ_CAPTAIN_PAJ_EXTENSION` to its extension
path otherwise. Tests use temporary storage and injected adapters or isolated processes, never your
live registry or normal tmux server. Nothing is installed by building or testing this package.

See [plan.md](plan.md) for the agreed Captain/Voice separation and delivery plan.
