import {expect, test} from '@drownek/plugwright';

test('command permission works', async ({ player }) => {
  player.chat('/example gui-settings');
  await expect(player).toHaveReceivedMessage('You don\'t have permission to execute this command! (example) (MISSING_PERMISSIONS)');
});

test('admin can interact with gui', async ({ player }) => {
  // 1. OP: to grant ability to execute command
  await player.makeOp();

  // 2. Action: Open the GUI and wait for it
  player.chat('/example gui-settings');
  const gui = await player.gui({ title: 'guiSettings' });

  // 3. Interact: Click the item named "guiItemInfo"
  await gui.locator(item => item.getDisplayName().includes('guiItemInfo')).click();

  // 4. Assertion: Check for the callback message
  await expect(player).toHaveReceivedMessage('You clicked on item');
});

test('help displays message', async ({ player }) => {
  player.chat('/help');
  await expect(player).toHaveReceivedMessage('Help');
});

// Reading the server log needs a console that streams all of it. An environment whose
// console only answers its own commands skips this test instead of failing it.
test('server logs command execution', { requires: ['consoleOutput:full'] }, async ({ server }) => {
  server.execute('say hello');
  await expect(server).toHaveReceivedMessage('hello');
});