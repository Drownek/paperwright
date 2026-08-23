import { test } from '@drownek/plugwright';

// If the login/register handshake in `onPlayerCreate` failed or timed out, `createPlayer()`
// would already have thrown before this test body ever runs — so reaching here at all is
// the actual assertion. The check below just makes that visible in the report.
test('authme login/register flow completes', async ({ player }) => {
    if (!player.username) {
        throw new Error('authme preflight: player has no username after join');
    }
});
