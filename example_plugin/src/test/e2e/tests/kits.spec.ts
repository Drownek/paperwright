import { describe, test, expect, sleep } from '@plugwright/runner';

// One player, three steps: what the second and third assert only exists because the first ran.
// Three independent bots could not express it, however they were scheduled.
describe.serial('kit lifecycle', () => {
  test('claims the starter kit', async ({ player }) => {
    player.chat('/kit starter');

    await expect(player).toHaveReceivedMessage('Received starter kit');
    await expect(player).toContainItem('diamond_sword');
    await expect(player).toContainItem('bread');
  });

  test('is on cooldown right after', async ({ player }) => {
    player.chat('/kit starter');
    await expect(player).toHaveReceivedMessage('cooldown');
  });

  test('can claim again once the cooldown expires', async ({ player }) => {
    await sleep(5000);

    player.chat('/kit starter');
    await expect(player).toHaveReceivedMessage('Received starter kit');
  });
});

// Op bypasses permission checks in Bukkit by default, so this only proves anything against a
// player that isn't one — which every test gets, since each one connects a fresh bot.
test('VIP kit requires permission', async ({ player }) => {
  player.chat('/kit vip');
  await expect(player).toHaveReceivedMessage('no permission');
});
