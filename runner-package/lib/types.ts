import type { PlayerWrapper } from './player.js';
import type { ServerWrapper } from './server.js';

export interface TestContext {
    player: PlayerWrapper;
    server: ServerWrapper;
    createPlayer: (options?: { username?: string }) => Promise<PlayerWrapper>;
    signal: AbortSignal;
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
}