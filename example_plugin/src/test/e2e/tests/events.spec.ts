import { test, expect } from '@plugwright/runner';

// Depends on the join itself, not just on a player's current state, so it always needs a
// brand-new connection — reuse would hand it a player who already joined once before.
test('player receives item on first join', { reuse: false }, async ({ player }) => {
  await expect(player).toHaveReceivedMessage('Welcome');
  await expect(player).toContainItem('wooden_sword');
});

test('scheduled announcement appears', async ({ player }) => {
  await expect(player).toHaveReceivedMessage('Server announcement');
});
