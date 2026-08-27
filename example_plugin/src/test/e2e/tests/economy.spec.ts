import { test, expect } from '@plugwright/runner';

test('player starts with default balance', async ({ player }) => {
  player.chat('/balance');
  await expect(player).toHaveReceivedMessage('$1000');
});

test('player can send money', async ({ player, server }) => {
  server.execute(`eco give ${player.username} 500`);
  player.chat('/pay Test_xx 100');
  await expect(player).toHaveReceivedMessage('Sent $100');
  
  player.chat('/balance');
  await expect(player).toHaveReceivedMessage('$1400');
});

test('cannot send more money than balance', async ({ player }) => {
  player.chat('/pay Test_xx 999999');
  await expect(player).toHaveReceivedMessage('insufficient');
});
