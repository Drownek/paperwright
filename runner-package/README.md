# @plugwright/runner

End-to-end testing runner for Paper/Spigot Minecraft plugins.

## Installation

```bash
npm install @plugwright/runner
```

## Quick Start

```javascript
import { test, expect } from '@plugwright/runner';

test('player can join server', async ({ player }) => {
  player.chat('/help');
  await expect(player).toHaveReceivedMessage('Available commands');
});

test('player can interact with GUI', async ({ player }) => {
    await player.makeOp();
    player.chat('/staffactivity view');

    // Get a live handle to the GUI
    const gui = await player.gui({ title: /Staff activity/ });

    // Create a locator for items
    const messageItem = gui.locator(i => i.hasLore('messages'));

    // Expectations automatically retry
    await expect(messageItem).toHaveLore('messages');
});
```

## Running against something other than a local server

The runner takes a config file describing one environment:

```bash
npx plugwright --config build/tmp/plugwright/local.json
```

The Gradle plugin writes that file, but nothing stops you from writing it yourself. `local` starts and stops its own Paper server; `external` connects to one that is already running, with an account pool, a console channel and authentication handled by a plugin. Two service modes exist for the second case: `--ping` checks that the server answers without running tests, and `--cleanup` replays outstanding cleanup work.

## Documentation

Full documentation is at [plugwright.dev](https://plugwright.dev). Start with [Environments](https://plugwright.dev/environments) for multi-server setups, and [Runner Plugins](https://plugwright.dev/plugins) for hooks, fixtures and custom matchers.

## License

MIT
