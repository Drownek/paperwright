import { test, expect } from '@plugwright/runner';

test('shop opens with correct items', async ({ player }) => {
  player.chat('/shop');
  const gui = await player.gui({ title: 'Shop' });
  
  const diamond = gui.locator(item => item.name === 'diamond');
  await expect.poll(() => diamond.displayName()).toContain('Diamond');
});

test('purchase item from shop', async ({ player }) => {
  await player.giveItem('emerald', 64); // Give currency
  player.chat('/shop');
  
  const gui = await player.gui({ title: 'Shop' });
  await gui.locator(item => item.name === 'diamond').click();
  
  await expect(player).toHaveReceivedMessage('Purchased');
  await expect(player).toContainItem('diamond');
});

// Depends on starting with no currency, which a reused player carried over from an earlier
// test can't promise — a fresh connection is the only way to guarantee it.
test('cannot buy without money', { reuse: false }, async ({ player }) => {
  player.chat('/shop');
  const gui = await player.gui({ title: 'Shop' });
  await gui.locator(item => item.name === 'diamond').click();
  
  await expect(player).toHaveReceivedMessage('Not enough money');
});
