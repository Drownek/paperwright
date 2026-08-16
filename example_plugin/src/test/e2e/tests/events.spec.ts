import { test, expect } from '@drownek/plugwright';

test('player receives item on first join', async ({ player }) => {
  await expect(player).toHaveReceivedMessage('Welcome');
  await expect(player).toContainItem('wooden_sword');
});

test('scheduled announcement appears', async ({ player }) => {
  await expect(player).toHaveReceivedMessage('Server announcement');
});
