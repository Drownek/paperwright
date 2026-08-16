import {expect, test} from '@drownek/plugwright';

test('help displays message', async ({ player, server }) => {
  player.chat('/help');
  await expect(player).toHaveReceivedMessage('Help');
});
