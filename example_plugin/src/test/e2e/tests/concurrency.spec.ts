/**
 * `concurrency` fans a test (or a `describe.serial` block) out into N independent bots running
 * at once — the shape a race between real players needs. These also stand in as regression
 * coverage for the two bugs that concurrency exposed in the previously-sequential-only runner:
 *  - `session.consoleLog` used to be wiped by `clear()` at the start of every test; N bots
 *    writing into it at once would have raced. Each instance now reads from its own
 *    `ServerWrapper.startIndex` cursor instead, so its own marker is never missed no matter what
 *    the other instances are doing to the same shared log.
 *  - `createBotScope.close()` used to disconnect every bot in the session, not just its own —
 *    the first instance to finish would have kicked every other still-running instance's bot.
 */

import { describe, expect, test } from '@plugwright/runner';

test('concurrent bots each see their own marker and stay connected', { concurrency: 3, requires: ['consoleOutput:full'] }, async ({ player, server }) => {
    const marker = `concurrency-marker-${player.username}`;
    player.chat(`/say ${marker}`);
    await expect(server).toHaveReceivedMessage(marker, { timeout: 10000 });

    // Still connected: an earlier-finishing sibling instance's teardown must not have
    // disconnected this one.
    await player.teleport(50, 100, 50);
    await expect(player).toBeNear(50, 100, 50, { tolerance: 2, timeout: 10000 });
});

describe.serial('concurrent kit lifecycle', { concurrency: 2 }, () => {
    test('claims the starter kit', async ({ player }) => {
        player.chat('/kit starter');

        await expect(player).toHaveReceivedMessage('Received starter kit');
        await expect(player).toContainItem('diamond_sword');
    });

    test('is on cooldown right after', async ({ player }) => {
        player.chat('/kit starter');
        await expect(player).toHaveReceivedMessage('cooldown');
    });
});
