import { test, expect } from '@plugwright/runner';

// Depends on the join itself, not just on a player's current state: it only holds for an
// account the server has never seen before.
test('player receives item on first join', async ({ player }) => {
  await expect(player).toHaveReceivedMessage('Welcome');
  await expect(player).toContainItem('wooden_sword');
});

test('scheduled announcement appears', async ({ player }) => {
  await expect(player).toHaveReceivedMessage('Server announcement');
});
