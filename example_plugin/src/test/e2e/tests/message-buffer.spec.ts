import { expect, test } from '@drownek/plugwright';

test('Cross-bot message separation', async ({ player, createPlayer }) => {
    const friend = await createPlayer({ username: 'FriendBot' });

    player.chat('/help');

    await expect(friend).not.toHaveReceivedMessage(/help|Available commands/i);
});

test('Rejoin clears message history', async ({ player }) => {
    await player.makeOp();
    player.chat('/say SomeMessage');

    await expect(player).toHaveReceivedMessage('SomeMessage');

    // clearMessages option is true by default, so message history is cleared and shouldn't contain the message
    await player.rejoin();

    await expect(player).not.toHaveReceivedMessage('SomeMessage');
});
