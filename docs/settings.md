# Settings

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
symlink, edit the source instead.
