import type { PlayerWrapper } from './player.js';
import type { ServerWrapper } from './server.js';

export interface TestContext {
    player: PlayerWrapper;
    server: ServerWrapper;
    /** Connects an extra bot. Inside a `describe.serial` block, `as` names it: the same name in
     *  a later test of that block returns the same bot instead of connecting another. Outside a
     *  block the name is scoped to the one test, which is as long as the bot lives anyway. */
    createPlayer: (options?: { username?: string; as?: string }) => Promise<PlayerWrapper>;
    /** Says the player is in a state the tests after this one were not written for. Inside a
     *  `describe.serial` block that stops the block: the rest is reported skipped. Outside one
     *  it does nothing — the bot is disconnected at the end of the test either way. */
    invalidatePlayer: (player: PlayerWrapper, reason?: string) => void;
    signal: AbortSignal;
    /** Registers a LIFO finalizer that always runs after the test body, before afterEach.
     *  Errors are logged but never override the test result. */
    cleanup: (fn: () => void | Promise<void>) => void;
}

export interface TestResult {
    file: string;
    testName: string;
    passed: boolean;
    durationMs: number;
    error?: Error;
    /** Set when the test was never run — a filter excluded it rather than it failing. */
    skipped?: boolean;
    /** Human-readable reason shown in reports; required whenever `skipped` is true. */
    skipReason?: string;
    /** Name of the plugin this test was inherited from, or null for a user spec. */
    plugin?: string | null;
}
