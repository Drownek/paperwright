import type { PlayerWrapper } from './player.js';
import type { ServerWrapper } from './server.js';

export interface TestContext {
    player: PlayerWrapper;
    server: ServerWrapper;
    /** Connects an extra bot. Inside a `describe.serial` block, `as` names it: the same name in
     *  a later test of that block returns the same bot instead of connecting another. Outside a
     *  block the name is scoped to the one test, which is as long as the bot lives anyway.
     *
     *  `username` asks for one specific identity instead of whatever the pool has free, and
     *  `password` is what an authentication plugin logs that identity in with. Read it from the
     *  environment rather than writing it in the spec — spec files go to git. */
    createPlayer: (options?: { username?: string; as?: string; password?: string }) => Promise<PlayerWrapper>;
    /** Says the player is in a state the tests after this one were not written for. Inside a
     *  `describe.serial` block that stops the block: the rest is reported skipped. Outside one
     *  it does nothing — the bot is disconnected at the end of the test either way. */
    invalidatePlayer: (player: PlayerWrapper, reason?: string) => void;
    signal: AbortSignal;
    /** Registers a LIFO finalizer that always runs after the test body, before afterEach.
     *  Errors are logged but never override the test result. */
    cleanup: (fn: () => void | Promise<void>) => void;
}

/** One concurrent instance's own outcome, rolled up into the `instances` array of the
 *  aggregate `TestResult` for a `concurrency > 1` test/block. */
export interface TestInstanceResult {
    /** 1-based position among the N concurrent instances — matches the `[i/N]` tag in the
     *  console log for this same run. */
    index: number;
    botUsername?: string;
    passed: boolean;
    durationMs: number;
    error?: Error;
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
    /** The bot that ran this test, when one connected. Absent for a skip, or a test that failed
     *  before it got as far as leasing a bot. */
    botUsername?: string;
    /** Set when this result aggregates `concurrency > 1` concurrent instances: `passed` is AND
     *  across all of them, `durationMs` is the slowest, `error` is the first failure. */
    instances?: TestInstanceResult[];
}
