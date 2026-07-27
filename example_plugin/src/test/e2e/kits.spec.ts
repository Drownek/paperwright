import { test, expect } from '@drownek/plugwright';

test('starter kit gives items', async ({ player }) => {
  player.chat('/kit starter');
  
  await expect(player).toHaveReceivedMessage('Received starter kit');
  await expect(player).toContainItem('diamond_sword');
  await expect(player).toContainItem('bread');
});

test('kit has cooldown', async ({ player }) => {
  player.chat('/kit starter');
  player.chat('/kit starter');
  await expect(player).toHaveReceivedMessage('cooldown');
});

test('VIP kit requires permission', async ({ player }) => {
  player.chat('/kit vip');
  await expect(player).toHaveReceivedMessage('no permission');
});
