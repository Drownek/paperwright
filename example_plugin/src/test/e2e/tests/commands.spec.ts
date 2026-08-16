import { test, expect } from '@drownek/plugwright';

test('help command shows available commands', async ({ player }) => {
  player.chat('/help');
  await expect(player).toHaveReceivedMessage('Help: Index');
});

test('unknown command shows error', async ({ player }) => {
  player.chat('/nonexistent');
  await expect(player).toHaveReceivedMessage('Unknown command');
});

test('permission-restricted command', async ({ player }) => {
  player.chat('/admin reload');
  await expect(player).toHaveReceivedMessage('no permission');
});

test('admin can use restricted command', async ({ player }) => {
  await player.makeOp();
  player.chat('/admin reload');
  await expect(player).toHaveReceivedMessage('Reloaded');
});
