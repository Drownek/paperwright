/**
 * Reproduces a bot reconnect while AuthMe still considers it logged in — no login/register
 * prompt arrives at all. Covers the fix: the authme plugin recognizes AuthMe's own
 * session-resume message and stops there, instead of guessing and sending a command blind.
 */

import { expect, test } from '@plugwright/runner';

test('rejoin resumes the session without a prompt', async ({ player }) => {
    // onPlayerCreate has already run and resolved by the time rejoin() returns, so the
    // resume message is in the buffer already — no extra wait needed.
    await player.rejoin();

    await expect(player).toHaveReceivedMessage(/session reconnection/i);
});
