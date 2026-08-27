import { test, expect } from '@plugwright/runner';

test('warp command teleports player', async ({ player }) => {
  player.chat('/warp spawn');
  await expect(player).toHaveReceivedMessage('Teleported to spawn');
  
  const pos = player.bot.entity.position;
  expect(pos.x).toBeCloseTo(0, 1);
  expect(pos.z).toBeCloseTo(0, 1);
});

test('unknown warp shows error', async ({ player }) => {
  player.chat('/warp nonexistent');
  await expect(player).toHaveReceivedMessage('Warp not found');
});

test('warp GUI lists available warps', async ({ player }) => {
  player.chat('/warps');
  const gui = await player.gui({ title: 'Warps' });
  
  const spawn = gui.locator(item => 
    item.getDisplayName().includes('Spawn')
  );
  await expect.poll(() => spawn.displayName()).toContain('Spawn');
  
  await gui.locator(item => item.name === 'compass').click(); // Assuming compass is spawn warp
  await expect(player).toHaveReceivedMessage('Teleported');
});
