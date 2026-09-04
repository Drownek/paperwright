import type { Session } from './session.js';
import type { Environment } from './environment.js';
import type { PlayerWrapper } from './player.js';
import type { TestContext } from './types.js';
import type { Account } from './account.js';

/** Bumped when a breaking change lands in the plugin contract. Checked against a loaded
 *  plugin's own `apiVersion` so a stale plugin fails with a clear message instead of a
 *  confusing runtime error. */
export const PLUGIN_API_VERSION = 1;

export interface SessionContext<O = unknown> {
    session: Session;
    env: Environment;
    options: O;
}

export interface CleanupContext {
    session: Session;
}

export interface PluginTestRef {
    /** Path to a compiled spec file, same format the runner's own `test()`/`describe()`
     *  files use. */
    file: string;
    /** `preflight` runs first, before user specs, and aborts the session on failure.
     *  `suite` runs alongside user specs as regular tests, tagged with the plugin's name
     *  in reports. */
    mode: 'preflight' | 'suite';
}

export type MatcherFn = (this: any, ...args: any[]) => unknown;

/**
 * Extends the test engine without the engine knowing about it: fixtures, matchers,
 * authentication hooks, inherited tests, cleanup.
 */
export interface PlugwrightPlugin<O = unknown> {
    name: string;
    apiVersion?: number;
    setup?(session: SessionContext<O>): Promise<void> | void;
    /** Fired on every bot connection — initial join and every `player.rejoin()` — not just
     *  the first. A one-shot "first test" can't cover a second bot or a rejoin, which is
     *  why this is a hook rather than a `preflight` test. */
    onPlayerCreate?(player: PlayerWrapper, ctx: { account: Account; env: Environment }): Promise<void> | void;
    beforeEach?(ctx: TestContext): Promise<void> | void;
    afterEach?(ctx: TestContext): Promise<void> | void;
    extendContext?(ctx: TestContext): Record<string, unknown> | void;
    matchers?: Record<string, MatcherFn>;
    tests?: PluginTestRef[];
    cleanup?(ctx: CleanupContext): Promise<void> | void;
    teardown?(): Promise<void> | void;
}

/** Identity function — exists for type inference at the plugin's definition site, the same
 *  role `defineConfig()` plays in other tools. */
export function definePlugin<O = unknown>(plugin: PlugwrightPlugin<O>): PlugwrightPlugin<O> {
    return plugin;
}
