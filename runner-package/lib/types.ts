import type { PlayerWrapper } from './player.js';
import type { ServerWrapper } from './server.js';
import type { ReuseOptions } from './player-registry.js';

export interface TestContext {
    player: PlayerWrapper;
    server: ServerWrapper;
    createPlayer: (options?: { username?: string; reuse?: false | string | ReuseOptions }) => Promise<PlayerWrapper>;
    /** Marks a player unfit for the next test: it disconnects instead of being handed out
     *  again. No-op for a player reuse never picked up (a plain fresh connection). */
    invalidatePlayer: (player: PlayerWrapper) => void;
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
    /** How the primary player was obtained. Absent when reuse is off for this run. */
    reuse?: { key: string; reused: boolean; abilities: string[] };
}