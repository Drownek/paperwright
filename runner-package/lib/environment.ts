import type { ServerConsole } from './console.js';
import type { Session } from './session.js';
import type { AccountPool } from './account.js';

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
    /** Absent or `true` means "allowed". `false` turns reuse off here entirely — an environment
     *  that breaks under a bot surviving a test boundary at all (a world reset between tests).
     *  `'rejoin'` is the middle ground for a server that only objects to the bot *sitting* there:
     *  entries are reused, but each one leaves at the end of its test and rejoins when a later
     *  test takes it. It caps `tests.reuse.stay` — a test asking for `stay: true` still gets a
     *  rejoin, the same way `false` outranks the config today. */
    playerReuse?: boolean | 'rejoin';
}

export interface BotConnectionOptions {
    host: string;
    port: number;
    version?: string;
    auth: 'offline' | 'microsoft' | 'mojang';
    /** Cache directory for a Microsoft device-code token, so a CI machine doesn't redo the
     *  interactive flow on every run. Only meaningful when `auth === 'microsoft'`. */
    profilesFolder?: string;
}

/**
 * A Minecraft server the runner can point bots at, plus however it needs to be
 * prepared and torn down. `local` spawns and kills its own Paper process;
 * `external` attaches to an already-running one instead.
 */
export interface Environment {
    readonly id: string;
    readonly capabilities: EnvironmentCapabilities;
    /** Prepares the server. Receives the session so output/bot bookkeeping lands there
     *  instead of in module state. */
    setup(session: Session): Promise<void>;
    connection(): BotConnectionOptions;
    console(): ServerConsole | null;
    /** Leasable accounts for this environment. Absent means "generate a throwaway
     *  `Test_<uuid>` per bot" — `local`'s only mode, unchanged from before `AccountPool`
     *  existed. */
    accounts?(): AccountPool | null;
    /** Called immediately before each bot connects. Environments that must not hammer a
     *  shared server (e.g. `external`'s `joinThrottleMs`) rate-limit connects here; the
     *  default (no-op when absent) matches `local`'s always-immediate connect. */
    beforeJoin?(): Promise<void>;
    teardown(): Promise<void>;
}
