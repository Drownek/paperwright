/**
 * Tests for basic PlayerWrapper methods.
 */

import { expect, test } from '@drownek/plugwright';

test('makeOp', async ({ player }) => {
    // This executes op server command, and we wait for response from server
    // so when await completes, we are sure player is op.
    await player.makeOp();

    // We additionally check for server message for clarity, but makeOp method already did this.
    // We check every 50ms for 5000ms whether player has received message,
    // if it is sent BEFORE that expect or within 5s window, test passes.
    // We have option `since` there, if we don't want to check previously sent messages in same test block.
    await expect(player).toHaveReceivedMessage(`Made ${player.username} a server operator`)
});

test('deOp', async ({ player }) => {
    // Works same as makeOp.
    await player.deOp();
    player.chat('/op');
    await expect(player).toHaveReceivedMessage('Unknown');
});

test('chat', async ({ player }) => {
    player.chat('/help');
    await expect(player).toHaveReceivedMessage('Help');
});

test('gamemode', async ({ player }) => {
    await player.setGameMode('adventure');

    // When we call `player.bot`, we have access to all Mineflayer bot variables that aren't implemented in our PlayerWrapper
    expect(player.bot.game.gameMode).toBe('adventure');
});

test('teleport', async ({ player }) => {
    await player.teleport(123, 100, 321)
    expect(player.bot.entity.position).toMatchObject({ x: 123.5, z: 321.5 });
});

test('giveItem', async ({ player }) => {
    await player.giveItem('emerald', 5)
    await expect(player).toContainItem('emerald', { count: 5 })
});