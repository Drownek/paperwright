import { test, expect } from '@drownek/plugwright';

test('join arena game', async ({ player }) => {
  player.chat('/arena join');
  await expect(player).toHaveReceivedMessage('Joined arena');
  
  player.chat('/arena leave');
  await expect(player).toHaveReceivedMessage('Left arena');
});

test('cannot join full arena', async ({ player, server }) => {
  // Fill arena with fake players
  for (let i = 0; i < 10; i++) {
    server.execute(`arena addplayer Player${i}`);
  }
  
  player.chat('/arena join');
  await expect(player).toHaveReceivedMessage('Arena is full');
});
