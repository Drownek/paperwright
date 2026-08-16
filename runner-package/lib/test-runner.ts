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
import { reuseTestRegistry } from './test-registry.js';
import { skipReasonForOptions } from './skip-reason.js';
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
    /** The running environment's configured name — `TestOptions.environments` on a `reuseTest`
     *  is checked against this, same as `runFile`'s own `skipReasonFor` checks it for a
     *  regular `TestCase`. */
    environmentName: string;
    /** Set when this test came from a plugin's inherited `tests`, for report labeling. */
    pluginName?: string | null;
    /** Whole-run setting: `tests.reuse.enabled` narrowed by the environment's
     *  `capabilities.playerReuse`. `false` reproduces the pre-reuse behavior exactly, down to
     *  the absence of `TestResult.reuse`. */
    reuseEnabled?: boolean;
    /** Whole-run default for `ReuseOptions.stay`: does a registry player keep its connection
     *  once this test is done, or does it park until a later test rejoins it. `'rejoin'` is the
     *  environment's own `capabilities.playerReuse` saying it can't hold an idle bot at all —
     *  a test asking for `stay: true` doesn't get to lift that. */
    reuseStay?: boolean | 'rejoin';
    /** Set for a plugin test file declaring `PluginTestRef.reuse === false` — forces a fresh
     *  connection for every test in the file regardless of `reuseEnabled` or the test's own
     *  `reuse` option. */
    forceReuseOff?: boolean;
    /** Reports a `reuseTest`'s own result, whenever one runs as a dependency of this test case.
     *  Called before `runTestCase` resolves, so the caller can append it to the report ahead of
     *  the test case's own result. */
    onExtraResult?: (result: TestResult) => void;
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
    const { file, testCase, session, plugins, connOpts, timeoutMs, environmentName, pluginName = null, reuseEnabled = false, reuseStay = true, forceReuseOff = false, onExtraResult } = params;

    console.log(`  ${pc.bold(`Test: ${testCase.name}`)}`);
    session.consoleLog.clear();

    const server = new ServerWrapper(session);
    const finalizers: Array<() => void | Promise<void>> = [];

    // Accounts leased outside the registry (a bypass `createPlayer({ username })`, or any
    // player created while reuse doesn't apply to this test) — returned in `finally` below,
    // same as before player reuse existed.
    const adhocAccounts: Array<{ account: Account; pool: AccountPool }> = [];
    // Players this test drew from the registry, with the `stay` each was taken under, so
    // `finally` knows what to release, what to park and what to drop.
    const registryPlayers: Array<{ player: PlayerWrapper; stay: boolean }> = [];
    const invalidated = new Set<PlayerWrapper>();
    const reuseEffective = reuseEnabled && !forceReuseOff;
    let primaryReuse: { key: string; reused: boolean; stay: boolean } | null = null;

    /** The run's `stay` unless the request overrides it — except under `'rejoin'`, where the
     *  environment has said an idle bot doesn't survive and no test gets to disagree. */
    const stayFor = (options: ReuseOptions): boolean =>
        reuseStay === 'rejoin' ? false : options.stay ?? reuseStay;

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

    /** Runs the `reuseTest` registered for `poolKey`, if any — called by `PlayerRegistry` right
     *  after it (re)connects that pool's player, before handing it to the test that triggered
     *  the (re)connect. Reported as its own test via `onExtraResult`; a throw here fails that
     *  dependent test too (see `PlayerRegistry.createEntry`, which discards the entry on
     *  failure so the next attempt runs this again instead of reusing a half-set-up player). */
    const runReuseTestCase = async (poolKey: string, reusePlayer: PlayerWrapper): Promise<void> => {
        const reuseCase = reuseTestRegistry.get(poolKey);
        if (!reuseCase) return;

        const skipReason = skipReasonForOptions(session.env, environmentName, reuseCase.requires, reuseCase.environments);
        if (skipReason) {
            // Same as a filtered-out regular test: skipped, not failed. A player handed out
            // under a pool whose reuseTest doesn't apply here still connects — it's just never
            // initialized, same as if no reuseTest had been declared for it at all.
            console.log(`  Test: ${reuseCase.name} - SKIPPED (${skipReason})`);
            onExtraResult?.({ file, testName: reuseCase.name, passed: true, durationMs: 0, skipped: true, skipReason, plugin: pluginName });
            return;
        }

        console.log(`  ${pc.bold(`Test: ${reuseCase.name}`)}`);
        const reuseAbort = new AbortController();
        const reuseFinalizers: Array<() => void | Promise<void>> = [];
        const reuseCtx: TestContext = {
            player: reusePlayer,
            server,
            createPlayer,
            invalidatePlayer: (p: PlayerWrapper) => { invalidated.add(p); },
            signal: reuseAbort.signal,
            cleanup: (fn: () => void | Promise<void>) => { reuseFinalizers.push(fn); },
        };
        plugins.extendContext(reuseCtx);

        const start = Date.now();
        let timeoutHandle: ReturnType<typeof setTimeout>;
        const timeoutPromise = new Promise<never>((_, reject) => {
            timeoutHandle = setTimeout(() => {
                reuseAbort.abort();
                reject(new Error(`reuseTest "${poolKey}" timed out after ${timeoutMs}ms`));
            }, timeoutMs);
        });

        // Same hook order as a regular test's body: plugin beforeEach → spec beforeEach → fn →
        // finalizers → spec afterEach → plugin afterEach.
        const body = (async (): Promise<void> => {
            await plugins.beforeEach(reuseCtx);
            for (const hook of reuseCase.beforeHooks) await hook(reuseCtx);

            let testError: unknown;
            try {
                await reuseCase.fn(reuseCtx);
            } catch (e) {
                testError = e;
            } finally {
                for (const finalizer of [...reuseFinalizers].reverse()) {
                    try {
                        await finalizer();
                    } catch (e) {
                        console.error(pc.red(`[cleanup] reuseTest "${poolKey}" finalizer error: ${(e as Error).message}`));
                    }
                }
                for (const hook of reuseCase.afterHooks) {
                    try {
                        await hook(reuseCtx);
                    } catch (e) {
                        testError ??= e;
                        console.error(pc.red(`[afterEach] reuseTest "${poolKey}" hook error: ${(e as Error).message}`));
                    }
                }
                await plugins.afterEach(reuseCtx);
            }
            if (testError) throw testError;
        })().finally(() => clearTimeout(timeoutHandle));

        try {
            await Promise.race([body, timeoutPromise]);
            const durationMs = Date.now() - start;
            console.log(`    ${pc.green(pc.bold('PASSED'))} ${pc.dim(`(${formatDuration(durationMs)})`)}\n`);
            onExtraResult?.({ file, testName: reuseCase.name, passed: true, durationMs, plugin: pluginName });
        } catch (error) {
            const durationMs = Date.now() - start;
            const errorMsg = (error as Error).message;
            console.log(`    ${pc.red(pc.bold('FAILED'))} ${pc.dim(`(${formatDuration(durationMs)})`)}: ${pc.red(errorMsg)}\n`);
            onExtraResult?.({ file, testName: reuseCase.name, passed: false, durationMs, error: error as Error, plugin: pluginName });
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

        const result = await session.players.resolve(
            normalized,
            () => connectNewPlayer(),
            normalized.key ? (key, p) => runReuseTestCase(key, p) : undefined,
        );
        registryPlayers.push({ player: result.player, stay: stayFor(normalized) });

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

    const testStartTime = Date.now();

    let player: PlayerWrapper;
    try {
        const resolved = await resolvePlayer(undefined, testCase.reuse);
        player = resolved.player;
        if (resolved.key !== null) {
            const normalized = normalizeReuse(testCase.reuse);
            primaryReuse = { key: resolved.key, reused: resolved.reused, stay: stayFor(normalized === false ? {} : normalized) };
        }
    } catch (error) {
        // The player never resolved — most likely this test's `reuseTest` dependency just
        // failed (see `runReuseTestCase`) and `PlayerRegistry` already discarded the half-built
        // entry. Reported as this test failing too, same as any other dependency failure.
        const durationMs = Date.now() - testStartTime;
        const errorMsg = (error as Error).message;
        console.log(`    ${pc.red(pc.bold('FAILED'))} ${pc.dim(`(${formatDuration(durationMs)})`)}: ${pc.red(errorMsg)}\n`);
        return {
            file, testName: testCase.name, passed: false, durationMs, error: error as Error, plugin: pluginName,
            reuse: reuseEnabled ? { key: 'none', reused: false, stay: false, abilities: [] } : undefined,
        };
    }
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
        for (const { player: p, stay } of registryPlayers) {
            const dead = !!(p.bot as any)._client?.ended;
            if (!testPassed || dead || invalidated.has(p)) {
                await session.players.invalidate(p, !testPassed ? 'test failed' : dead ? 'connection dead' : 'invalidated by test');
            } else {
                // `stay: false` disconnects here too, but keeps the entry: the next test that
                // asks for this shape of player gets the same identity back, rejoined.
                await session.players.release(p, stay);
            }
        }
        // Keep every bot the registry owns, not just the ones this test happened to touch —
        // a free entry another test will pick up later is not this test's to disconnect.
        await session.disconnectAllBots(session.players.ownedBots());
        for (const { account, pool } of adhocAccounts) pool.release(account);
    }

    function reportedReuse(): TestResult['reuse'] {
        if (!reuseEnabled) return undefined;
        if (!primaryReuse) return { key: 'none', reused: false, stay: false, abilities: [] };
        return { key: primaryReuse.key, reused: primaryReuse.reused, stay: primaryReuse.stay, abilities: [...player.abilities] };
    }
}
