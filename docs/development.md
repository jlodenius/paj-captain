# Development

[Back to setup](../README.md).

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
