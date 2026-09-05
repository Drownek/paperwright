import { definePlugin, waitUntil } from '@plugwright/runner';

/** What a fresh account starts with, per ExamplePlugin's own default. */
const STARTING_BALANCE = 1000;

/**
 * Undoes what one test leaves on a leased account before the next test gets it.
 *
 * The local environment never needs this: it hands every test a brand new username on a
 * server it just created. An external stand has neither — the same four accounts come back
 * around all run, still opped, still holding whatever the last test gave them.
 *
 * Everything reset here is state the plugin under test owns, which is why this lives in the
 * example project rather than in the runner: only the suite knows what "back to the start"
 * means for the plugin it tests, and what commands say it.
 *
 * Loaded through `plugins { local(...) }` in build.gradle.kts, for the "stand" environment
 * only.
 */
export default definePlugin({
    name: 'stand-reset',

    async beforeEach({ player, server }) {
        // Nothing to reset with: an environment without a console cannot run commands at all,
        // and the tests that depend on this reset are excluded there anyway.
        if (!server.session.env.capabilities.console) return;

        await player.deOp();
        await player.clearInventory();

        server.execute(`eco set ${player.username} ${STARTING_BALANCE}`);
        server.execute(`kit reset ${player.username}`);

        // Wait for the server to process the commands before starting tests
        const syncId = `sync_reset_${Math.random().toString(36).slice(2, 8)}`;
        server.execute(`minecraft:say ${syncId}`);
        await waitUntil(
            () => player.messageBuffer.some(m => m.includes(syncId)),
            { message: `Reset sync timed out for ${player.username}`, timeout: 5000 }
        );
    },
});
