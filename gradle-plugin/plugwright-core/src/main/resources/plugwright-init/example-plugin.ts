import { definePlugin } from '@drownek/plugwright';

/**
 * A runner plugin: hooks that run around every test, plus fixtures the tests can
 * destructure. Load it by adding this to the environment in build.gradle.kts:
 *
 *     plugins { local("example-plugin") }
 *
 * The name is the file name — plugwright compiles plugins/example-plugin.ts into
 * dist/plugins/example-plugin.js and points the runner at that.
 */
export default definePlugin({
    name: 'example-plugin',

    // Runs before every test, with the bot already connected.
    async beforeEach({ player, server }) {
        // An environment without a console has no way to run commands, and says so.
        if (!server.session.env.capabilities.console) return;
        await server.executeAndWait(`minecraft:gamemode survival ${player.username}`);
    },

    // What this returns becomes part of the object every test destructures:
    // test('...', async ({ player, say }) => { ... })
    extendContext({ player }) {
        return { say: (message: string) => player.chat(message) };
    },
});

// Without this block the fixture still works and TypeScript still complains.
declare module '@drownek/plugwright' {
    interface TestContext {
        say: (message: string) => void;
    }
}
