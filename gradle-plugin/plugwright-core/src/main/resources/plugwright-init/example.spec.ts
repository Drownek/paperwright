import {expect, test} from '@plugwright/runner';

test('help displays message', async ({ player, server }) => {
  player.chat('/help');
  await expect(player).toHaveReceivedMessage('Help');
});
