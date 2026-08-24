/**
 * We test there whether multi-player tests are working as well.
 */

import { expect, test } from '@drownek/plugwright';

test('multi-bot teleportation', async ({ player, createPlayer }) => {
    // This executes op server command, and we wait for response from server
    // so when await completes, we are sure player is op.
    // This can be also done with defining test as `opTest` instead of `test` or even within `beforeEach` block.
    await player.makeOp();

    // Spawn a second player
    const friend = await createPlayer({ username: 'FriendBot' });

    // Teleport the friend to a specific location
    // We wait for friend player to actually teleport.
    await friend.teleport(100, 100, 100);
    
    // Teleport primary player to the friend
    // We cant be sure that message was sent and fully processed, so it not a promise.
    // In this case, we should check whether teleporting has succeeded, so we expect player position in next step.
    player.chat(`/tp ${player.username} ${friend.username}`);

    // Verify the primary player is near the friend
    // Even if server hadn't processed teleport command yet, this method is waiting for default of 5000ms
    // If player got teleported within that 15s window, test passes.
    await expect(player).toBeNear(100, 100, 100, { tolerance: 2, timeout: 15000 });
});
