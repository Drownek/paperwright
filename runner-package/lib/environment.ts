import type { ServerConsole } from './console.js';
import type { Session } from './session.js';

/** What an environment actually supports. Declared expectations in the DSL are checked
 *  against this after `setup()`; a mismatch is printed once in the run header. */
export interface EnvironmentCapabilities {
    console: boolean;
    consoleOutput: 'full' | 'responses' | 'none';
    op: boolean;
    freshState: boolean;
    arbitraryUsernames: boolean;
    lifecycle: boolean;
    cleanupStrategy: 'wipe' | 'compensating' | 'none';
}

export interface BotConnectionOptions {
    host: string;
    port: number;
    version?: string;
    auth: 'offline' | 'microsoft' | 'mojang';
}

/**
 * A Minecraft server the runner can point bots at, plus however it needs to be
 * prepared and torn down. `local` spawns and kills its own Paper process;
 * `external` (a later phase) attaches to an already-running server instead.
 */
export interface Environment {
    readonly id: string;
    readonly capabilities: EnvironmentCapabilities;
    /** Prepares the server. Receives the session so output/bot bookkeeping lands there
     *  instead of in module state. */
    setup(session: Session): Promise<void>;
    connection(): BotConnectionOptions;
    console(): ServerConsole | null;
    teardown(): Promise<void>;
}
