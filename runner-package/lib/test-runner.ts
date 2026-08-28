import pc from 'picocolors';
import { PlayerWrapper } from './player.js';
import { ServerWrapper } from './server.js';
import { formatDuration } from './reporter.js';
import { randomSuffix, syntheticAccount } from './account.js';
import type { Account, AccountPool } from './account.js';
import type { Session } from './session.js';
import type { PluginHost } from './plugin-host.js';
import type { BotConnectionOptions } from './environment.js';
import type { SerialBlock, TestCase } from './test-registry.js';
import type { TestContext, TestResult } from './types.js';

export interface RunTestCaseParams {
    file: string;
    testCase: TestCase;
    session: Session;
    plugins: PluginHost;
    connOpts: BotConnectionOptions;
    timeoutMs: number;
    /** Set when this test came from a plugin's inherited `tests`, for report labeling. */
    pluginName?: string | null;
}

export interface RunSerialBlockParams {
    file: string;
    block: SerialBlock;
    session: Session;
    plugins: PluginHost;
    connOpts: BotConnectionOptions;
    timeoutMs: number;
    pluginName?: string | null;
}

/** Bots created while one test, or one `describe.serial` block, is running: who leased what,
 *  which player answers to which `as` name, and how to give it all back. */
interface BotScope {
    connect(options?: { username?: string; account?: string }): Promise<PlayerWrapper>;
    /** `ctx.createPlayer`. `as` names the player so a later call — a later test, inside a block —
     *  gets the same bot back instead of connecting a second one. */
    createPlayer(options?: { username?: string; as?: string }): Promise<PlayerWrapper>;
    /** Every player connected in this scope, in the order they joined. */
    players(): PlayerWrapper[];
    /** Disconnects every bot in the scope and returns the accounts they held. */
    close(): Promise<void>;
}

function createBotScope(session: Session, server: ServerWrapper, connOpts: BotConnectionOptions): BotScope {
    const leased: Array<{ account: Account; pool: AccountPool }> = [];
    const named = new Map<string, PlayerWrapper>();
    const connected: PlayerWrapper[] = [];

    const connect = async (options?: { username?: string; account?: string }): Promise<PlayerWrapper> => {
        const pool = options?.username ? null : session.env.accounts?.() ?? null;
        if (options?.account && !pool) {
            throw new Error(
                `account "${options.account}" was requested, but environment "${session.env.id}" has no accounts pool ` +
                'to take it from — a named account needs one the build script declares.'
            );
        }
        const account: Account = pool
            ? await pool.lease(options?.account)
            : syntheticAccount(options?.username || `pw_${randomSuffix()}`);

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
            if (pool) leased.push({ account, pool });
            connected.push(player);
            return player;
        } catch (error) {
            if (pool) pool.release(account);
            throw error;
        }
    };

    return {
        connect,
        async createPlayer(options): Promise<PlayerWrapper> {
            const handle = options?.as;
            if (handle) {
                const existing = named.get(handle);
                if (existing) return existing;
            }
            const player = await connect({ username: options?.username });
            if (handle) named.set(handle, player);
            return player;
        },
        players: () => [...connected],
        async close(): Promise<void> {
            await session.disconnectAllBots();
            for (const { account, pool } of leased) pool.release(account);
            leased.length = 0;
            named.clear();
            connected.length = 0;
        },
    };
}

interface ExecuteParams {
    testCase: TestCase;
    ctx: TestContext;
    finalizers: Array<() => void | Promise<void>>;
    abort: AbortController;
    plugins: PluginHost;
    timeoutMs: number;
    /** Plugin `beforeEach`/`afterEach` wrap a whole `describe.serial` block rather than each of
     *  its tests, so a block runs them around its first and last test only. */
    pluginBeforeEach: boolean;
    pluginAfterEach: boolean;
}

/**
 * Runs one test body with its hooks, and throws whatever failed it. Order is plugin beforeEach →
 * spec beforeEach → body → cleanup finalizers → spec afterEach → plugin afterEach. Finalizer
 * errors are logged but never flip the result; spec afterEach errors do, matching the runner's
 * pre-plugin-host behavior.
 */
async function executeTest(params: ExecuteParams): Promise<void> {
    const { testCase, ctx, finalizers, abort, plugins, timeoutMs, pluginBeforeEach, pluginAfterEach } = params;

    let timeoutHandle: ReturnType<typeof setTimeout>;
    const timeoutPromise = new Promise<never>((_, reject) => {
        timeoutHandle = setTimeout(() => {
            abort.abort();
            reject(new Error(`Test timed out after ${timeoutMs}ms. You can increase this by setting the TEST_TIMEOUT environment variable.`));
        }, timeoutMs);
    });

    const body = async (): Promise<void> => {
        if (pluginBeforeEach) await plugins.beforeEach(ctx);
        for (const hook of testCase.beforeHooks) await hook(ctx);

        let testError: unknown;
        try {
            await testCase.fn(ctx);
        } catch (e) {
            testError = e;
        } finally {
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
            if (pluginAfterEach) await plugins.afterEach(ctx);
        }
        if (testError) throw testError;
    };

    await Promise.race([body().finally(() => clearTimeout(timeoutHandle)), timeoutPromise]);
}

function reportPassed(durationMs: number): void {
    console.log(`    ${pc.green(pc.bold('PASSED'))} ${pc.dim(`(${formatDuration(durationMs)})`)}\n`);
}

function reportFailed(durationMs: number, error: Error): void {
    console.log(`    ${pc.red(pc.bold('FAILED'))} ${pc.dim(`(${formatDuration(durationMs)})`)}: ${pc.red(error.message)}\n`);
}

/**
 * Runs one standalone test case end to end: connects its own bot, builds `TestContext`, runs the
 * body, and disconnects everything it created on the way out.
 */
export async function runTestCase(params: RunTestCaseParams): Promise<TestResult> {
    const { file, testCase, session, plugins, connOpts, timeoutMs, pluginName = null } = params;

    console.log(`  ${pc.bold(`Test: ${testCase.name}`)}`);
    session.consoleLog.clear();

    const server = new ServerWrapper(session);
    const bots = createBotScope(session, server, connOpts);
    const finalizers: Array<() => void | Promise<void>> = [];
    const startedAt = Date.now();

    let player: PlayerWrapper;
    try {
        player = await bots.connect();
    } catch (error) {
        const durationMs = Date.now() - startedAt;
        reportFailed(durationMs, error as Error);
        await bots.close();
        return { file, testName: testCase.name, passed: false, durationMs, error: error as Error, plugin: pluginName };
    }

    const abort = new AbortController();
    const ctx: TestContext = {
        player,
        server,
        createPlayer: options => bots.createPlayer(options),
        invalidatePlayer: () => { /* nothing follows this test — see the serial-block runner */ },
        signal: abort.signal,
        cleanup: (fn: () => void | Promise<void>) => { finalizers.push(fn); },
    };
    plugins.extendContext(ctx);

    try {
        await executeTest({
            testCase, ctx, finalizers, abort, plugins, timeoutMs,
            pluginBeforeEach: true, pluginAfterEach: true,
        });
        const durationMs = Date.now() - startedAt;
        reportPassed(durationMs);
        return { file, testName: testCase.name, passed: true, durationMs, plugin: pluginName };
    } catch (error) {
        const durationMs = Date.now() - startedAt;
        reportFailed(durationMs, error as Error);
        return { file, testName: testCase.name, passed: false, durationMs, error: error as Error, plugin: pluginName };
    } finally {
        await bots.close();
    }
}

/**
 * Runs a `describe.serial` block: one player, one connection, its tests in declaration order.
 *
 * The block stops at the first test that fails, times out, or calls `invalidatePlayer` — every
 * test after it is reported skipped rather than failed, because what they were written against
 * is a state the block never reached. Plugin `beforeEach`/`afterEach` wrap the block, not each
 * test: a plugin that resets an account between tests would undo what the block is built on.
 */
export async function runSerialBlock(params: RunSerialBlockParams): Promise<TestResult[]> {
    const { file, block, session, plugins, connOpts, timeoutMs, pluginName = null } = params;

    console.log(`  ${pc.bold(`Serial block: ${block.name}`)}${block.account ? pc.dim(` (account ${block.account})`) : ''}`);
    session.consoleLog.clear();

    const server = new ServerWrapper(session);
    const bots = createBotScope(session, server, connOpts);
    const results: TestResult[] = [];

    let player: PlayerWrapper;
    try {
        player = await bots.connect({ account: block.account ?? undefined });
    } catch (error) {
        // Nothing in the block ever ran: the first test carries the failure, the rest are
        // skipped the same way they would be after a failure further in.
        reportFailed(0, error as Error);
        await bots.close();
        return block.tests.map((testCase, index) => index === 0
            ? { file, testName: testCase.name, passed: false, durationMs: 0, error: error as Error, plugin: pluginName }
            : {
                file, testName: testCase.name, passed: true, durationMs: 0, skipped: true,
                skipReason: `serial block "${block.name}" never got its player: ${(error as Error).message}`,
                plugin: pluginName,
            });
    }

    let stopReason: string | null = null;
    // The context object is rebuilt per test — `cleanup` and `signal` are per-test — but every
    // one of them carries the same player and the same bot scope.
    let lastCtx: TestContext | null = null;

    try {
        for (const [index, testCase] of block.tests.entries()) {
            if (stopReason) {
                console.log(pc.dim(`  Test: ${testCase.name} - SKIPPED (${stopReason})`));
                results.push({
                    file, testName: testCase.name, passed: true, durationMs: 0, skipped: true,
                    skipReason: stopReason, plugin: pluginName,
                });
                continue;
            }

            console.log(`  ${pc.bold(`Test: ${testCase.name}`)}`);
            // What the block shares is server state, not chat history: a message from the step
            // before would otherwise satisfy an assertion about this one.
            session.consoleLog.clear();
            for (const p of bots.players()) p.clearMessages();

            const finalizers: Array<() => void | Promise<void>> = [];
            const abort = new AbortController();
            let invalidatedBy: string | null = null;

            const ctx: TestContext = {
                player,
                server,
                createPlayer: options => bots.createPlayer(options),
                invalidatePlayer: (p, reason) => {
                    if (p === player) invalidatedBy = reason ?? `invalidated by "${testCase.name}"`;
                },
                signal: abort.signal,
                cleanup: (fn: () => void | Promise<void>) => { finalizers.push(fn); },
            };
            plugins.extendContext(ctx);
            lastCtx = ctx;

            const startedAt = Date.now();
            try {
                await executeTest({
                    testCase, ctx, finalizers, abort, plugins, timeoutMs,
                    pluginBeforeEach: index === 0,
                    // Once around the block: see the `finally` below, which runs it whether the
                    // block finished its tests or stopped partway.
                    pluginAfterEach: false,
                });
                const durationMs = Date.now() - startedAt;
                reportPassed(durationMs);
                results.push({ file, testName: testCase.name, passed: true, durationMs, plugin: pluginName });
            } catch (error) {
                const durationMs = Date.now() - startedAt;
                reportFailed(durationMs, error as Error);
                results.push({ file, testName: testCase.name, passed: false, durationMs, error: error as Error, plugin: pluginName });
                stopReason = `serial block "${block.name}" stopped at "${testCase.name}"`;
                continue;
            }

            const dead = !!(player.bot as any)._client?.ended;
            if (invalidatedBy) {
                stopReason = `serial block "${block.name}" stopped: ${invalidatedBy}`;
            } else if (dead) {
                stopReason = `serial block "${block.name}" stopped: ${player.username} lost its connection`;
            }
        }
    } finally {
        if (lastCtx) await plugins.afterEach(lastCtx);
        await bots.close();
    }

    return results;
}
