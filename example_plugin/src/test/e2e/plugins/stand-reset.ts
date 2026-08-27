import { definePlugin } from '@plugwright/runner';

/**
 * Undoes what one test leaves on a leased account before the next test gets it.
 *
 * The local environment never needs this: it hands every test a brand new username on a
 * server it just created. An external stand has neither — the same four accounts come back
 * around all run, still opped and still holding whatever the last test gave them.
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

        await server.executeAndWait(`minecraft:deop ${player.username}`);
        await server.executeAndWait(`minecraft:clear ${player.username}`);
    },
});
