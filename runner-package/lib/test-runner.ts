import { randomUUID } from 'node:crypto';
import pc from 'picocolors';
import { PlayerWrapper } from './player.js';
import { ServerWrapper } from './server.js';
import { formatDuration } from './reporter.js';
import { syntheticAccount } from './account.js';
import type { Account, AccountPool } from './account.js';
import type { Session } from './session.js';
import type { PluginHost } from './plugin-host.js';
import type { BotConnectionOptions } from './environment.js';
import type { TestCase } from './test-registry.js';
import type { TestContext, TestResult } from './types.js';
import type { ConnectedPlayer, ReuseOptions } from './player-registry.js';

export interface RunTestCaseParams {
    file: string;
    testCase: TestCase;
    session: Session;
    plugins: PluginHost;
    connOpts: BotConnectionOptions;
    timeoutMs: number;
    /** Set when this test came from a plugin's inherited `tests`, for report labeling. */
    pluginName?: string | null;
    /** Whole-run setting: `tests.reuse.enabled` narrowed by the environment's
     *  `capabilities.playerReuse`. `false` reproduces the pre-reuse behavior exactly, down to
     *  the absence of `TestResult.reuse`. */
    reuseEnabled?: boolean;
    /** Set for a plugin test file declaring `PluginTestRef.reuse === false` — forces a fresh
     *  connection for every test in the file regardless of `reuseEnabled` or the test's own
     *  `reuse` option. */
    forceReuseOff?: boolean;
}

/** Normalizes a `TestOptions.reuse` value to what `PlayerRegistry.resolve` takes. */
function normalizeReuse(reuse: false | string | ReuseOptions | undefined): false | ReuseOptions {
    if (reuse === false) return false;
    if (reuse === undefined) return {};
    if (typeof reuse === 'string') return { key: reuse };
    return reuse;
}

/**
 * Runs one test case end to end: resolves the primary bot (a fresh connection, or — when
 * reuse applies — a registry lookup that may hand back a player from an earlier test), builds
 * `TestContext`, and sequences hooks in order — plugin beforeEach → spec beforeEach → body →
 * cleanup finalizers → spec afterEach → plugin afterEach. Finalizer errors are logged but
 * never flip the test result; spec afterEach errors do, matching the runner's pre-plugin-host
 * behavior.
 */
export async function runTestCase(params: RunTestCaseParams): Promise<TestResult> {
    const { file, testCase, session, plugins, connOpts, timeoutMs, pluginName = null, reuseEnabled = false, forceReuseOff = false } = params;

    console.log(`  ${pc.bold(`Test: ${testCase.name}`)}`);
    session.consoleLog.clear();

    const server = new ServerWrapper(session);
    const finalizers: Array<() => void | Promise<void>> = [];

    // Accounts leased outside the registry (a bypass `createPlayer({ username })`, or any
    // player created while reuse doesn't apply to this test) — returned in `finally` below,
    // same as before player reuse existed.
    const adhocAccounts: Array<{ account: Account; pool: AccountPool }> = [];
    // Players this test drew from the registry, so `finally` knows what to release or drop.
    const registryPlayers: PlayerWrapper[] = [];
    const invalidated = new Set<PlayerWrapper>();
    const reuseEffective = reuseEnabled && !forceReuseOff;
    let primaryReuse: { key: string; reused: boolean } | null = null;

    // The actual connect: leases an account (or generates a throwaway identity), joins the
    // server, and returns the wrapper. Used directly for a fresh connection, and passed to
    // the registry as the "nothing free matched" fallback.
    const connectNewPlayer = async (options?: { username?: string }): Promise<ConnectedPlayer> => {
        const pool = options?.username ? null : session.env.accounts?.() ?? null;
        const account: Account = pool
            ? await pool.lease()
            : syntheticAccount(options?.username || `Test_${randomUUID().split('-')[0]}`);

        try {
            const botUsername = account.username;
            console.log(`${pc.cyan('[Bot]')} Creating bot: ${pc.bold(botUsername)}`);

            await session.env.beforeJoin?.();

            const botOptions: BotConnectionOptions = {
                ...connOpts,
                auth: account.auth,
                profilesFolder: account.microsoftCacheDir,
            };
            const bot = session.createBot({ ...botOptions, username: botUsername });
            const player = new PlayerWrapper(bot, session);
            player._captureSpawnPromise();
            player.setServerWrapper(server);
            player._setBotOptions(botOptions);
            player._setAccount(account);

            await player.join();
            return { player, account, pool };
        } catch (error) {
            if (pool) pool.release(account);
            throw error;
        }
    };

    /** `ctx.player` and `ctx.createPlayer` both funnel through here. `usernameOverride` is
     *  `createPlayer({ username })` — a specific identity, which always bypasses both the
     *  account pool and the registry, same as before reuse existed. */
    const resolvePlayer = async (
        usernameOverride: string | undefined,
        reuseRequest: false | string | ReuseOptions | undefined,
    ): Promise<{ player: PlayerWrapper; key: string; reused: boolean } | { player: PlayerWrapper; key: null; reused: false }> => {
        if (usernameOverride) {
            const { player } = await connectNewPlayer({ username: usernameOverride });
            return { player, key: null, reused: false };
        }

        const normalized = normalizeReuse(reuseRequest);
        if (!reuseEffective || normalized === false) {
            const { player, account, pool } = await connectNewPlayer();
            if (pool) adhocAccounts.push({ account, pool });
            return { player, key: null, reused: false };
        }

        const result = await session.players.resolve(normalized, () => connectNewPlayer());
        registryPlayers.push(result.player);

        if (result.reused) {
            // Core's own safe minimum for a player coming back from a previous test — anything
            // beyond this is the plugin's domain via onPlayerReuse.
            const openWindow = result.player.bot.currentWindow;
            if (openWindow) {
                try { result.player.bot.closeWindow(openWindow); } catch { /* best effort */ }
            }
            await plugins.onPlayerReuse(result.player, { account: result.player.account!, env: session.env });
        }

        return { player: result.player, key: result.key, reused: result.reused };
    };

    const createPlayer = async (options?: { username?: string; reuse?: false | string | ReuseOptions }): Promise<PlayerWrapper> => {
        const { player } = await resolvePlayer(options?.username, options?.reuse);
        return player;
    };

    const { player, key: primaryKey, reused: primaryReused } = await resolvePlayer(undefined, testCase.reuse);
    if (primaryKey !== null) primaryReuse = { key: primaryKey, reused: primaryReused };
    const abortController = new AbortController();

    const ctx: TestContext = {
        player,
        server,
        createPlayer,
        invalidatePlayer: (p: PlayerWrapper) => { invalidated.add(p); },
        signal: abortController.signal,
        cleanup: (fn: () => void | Promise<void>) => { finalizers.push(fn); },
    };

    plugins.extendContext(ctx);

    const testStartTime = Date.now();
    let testPassed = false;

    try {
        let timeoutHandle: ReturnType<typeof setTimeout>;
        const timeoutPromise = new Promise<never>((_, reject) => {
            timeoutHandle = setTimeout(() => {
                abortController.abort();
                reject(new Error(`Test timed out after ${timeoutMs}ms. You can increase this by setting the TEST_TIMEOUT environment variable.`));
            }, timeoutMs);
        });

        const body = async (): Promise<void> => {
            await plugins.beforeEach(ctx);
            for (const hook of testCase.beforeHooks) await hook(ctx);

            let testError: unknown;
            try {
                await testCase.fn(ctx);
            } catch (e) {
                testError = e;
            } finally {
                // Finalizers run before afterEach. Their errors are logged only — a
                // cleanup hiccup isn't a second chance to fail the test.
                for (const finalizer of [...finalizers].reverse()) {
                    try {
                        await finalizer();
                    } catch (e) {
                        console.error(pc.red(`[cleanup] finalizer error: ${(e as Error).message}`));
                    }
                }
                for (const hook of testCase.afterHooks) {
                    try {
                        await hook(ctx);
                    } catch (e) {
                        testError ??= e;
                        console.error(pc.red(`[afterEach] Hook error: ${(e as Error).message}`));
                    }
                }
                await plugins.afterEach(ctx);
            }
            if (testError) throw testError;
        };

        await Promise.race([body().finally(() => clearTimeout(timeoutHandle)), timeoutPromise]);

        testPassed = true;
        const durationMs = Date.now() - testStartTime;
        console.log(`    ${pc.green(pc.bold('PASSED'))} ${pc.dim(`(${formatDuration(durationMs)})`)}\n`);
        return { file, testName: testCase.name, passed: true, durationMs, plugin: pluginName, reuse: reportedReuse() };
    } catch (error) {
        const durationMs = Date.now() - testStartTime;
        const errorMsg = (error as Error).message;
        console.log(`    ${pc.red(pc.bold('FAILED'))} ${pc.dim(`(${formatDuration(durationMs)})`)}: ${pc.red(errorMsg)}\n`);
        return { file, testName: testCase.name, passed: false, durationMs, error: error as Error, plugin: pluginName, reuse: reportedReuse() };
    } finally {
        // A failed or timed-out test hands nothing forward: one bad test turning into a
        // cascade of unrelated failures would put the real cause somewhere other than the
        // report points at.
        for (const p of registryPlayers) {
            const dead = !!(p.bot as any)._client?.ended;
            if (!testPassed || dead || invalidated.has(p)) {
                await session.players.invalidate(p, !testPassed ? 'test failed' : dead ? 'connection dead' : 'invalidated by test');
            } else {
                session.players.release(p);
            }
        }
        // Keep every bot the registry owns, not just the ones this test happened to touch —
        // a free entry another test will pick up later is not this test's to disconnect.
        await session.disconnectAllBots(session.players.ownedBots());
        for (const { account, pool } of adhocAccounts) pool.release(account);
    }

    function reportedReuse(): TestResult['reuse'] {
        if (!reuseEnabled) return undefined;
        if (!primaryReuse) return { key: 'none', reused: false, abilities: [] };
        return { key: primaryReuse.key, reused: primaryReuse.reused, abilities: [...player.abilities] };
    }
}
