import { test, expect } from '@plugwright/runner';

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

// Op bypasses permission checks in Bukkit by default, so this only proves anything against a
// player that isn't one.
test('VIP kit requires permission', { reuse: { excludeAbilities: ['op'] } }, async ({ player }) => {
  player.chat('/kit vip');
  await expect(player).toHaveReceivedMessage('no permission');
});
