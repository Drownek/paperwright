import pc from 'picocolors';
import { PlayerWrapper } from './player.js';
import { ServerWrapper } from './server.js';
import { formatDuration } from './reporter.js';
import { randomSuffix, syntheticAccount } from './account.js';
import type { Account, AccountPool } from './account.js';
import type { Session } from './session.js';
import type { PluginHost } from './plugin-host.js';
import type { BotConnectionOptions } from './environment.js';
import type { TestCase } from './test-registry.js';
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

/**
 * Runs one test case end to end: connects the primary bot, builds `TestContext`, and sequences
 * hooks in order — plugin beforeEach → spec beforeEach → body → cleanup finalizers → spec
 * afterEach → plugin afterEach. Finalizer errors are logged but never flip the test result;
 * spec afterEach errors do, matching the runner's pre-plugin-host behavior.
 */
export async function runTestCase(params: RunTestCaseParams): Promise<TestResult> {
    const { file, testCase, session, plugins, connOpts, timeoutMs, pluginName = null } = params;

    console.log(`  ${pc.bold(`Test: ${testCase.name}`)}`);
    session.consoleLog.clear();

    const server = new ServerWrapper(session);
    const finalizers: Array<() => void | Promise<void>> = [];

    // Accounts leased for this test, returned to the pool in `finally` below.
    const leasedAccounts: Array<{ account: Account; pool: AccountPool }> = [];

    // The actual connect: leases an account (or generates a throwaway identity), joins the
    // server, and returns the wrapper.
    const connectNewPlayer = async (options?: { username?: string }): Promise<PlayerWrapper> => {
        const pool = options?.username ? null : session.env.accounts?.() ?? null;
        const account: Account = pool
            ? await pool.lease()
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
            if (pool) leasedAccounts.push({ account, pool });
            return player;
        } catch (error) {
            if (pool) pool.release(account);
            throw error;
        }
    };

    const createPlayer = async (options?: { username?: string }): Promise<PlayerWrapper> =>
        connectNewPlayer({ username: options?.username });

    const testStartTime = Date.now();

    let player: PlayerWrapper;
    try {
        player = await connectNewPlayer();
    } catch (error) {
        const durationMs = Date.now() - testStartTime;
        const errorMsg = (error as Error).message;
        console.log(`    ${pc.red(pc.bold('FAILED'))} ${pc.dim(`(${formatDuration(durationMs)})`)}: ${pc.red(errorMsg)}\n`);
        for (const { account, pool } of leasedAccounts) pool.release(account);
        return { file, testName: testCase.name, passed: false, durationMs, error: error as Error, plugin: pluginName };
    }

    const abortController = new AbortController();

    const ctx: TestContext = {
        player,
        server,
        createPlayer,
        signal: abortController.signal,
        cleanup: (fn: () => void | Promise<void>) => { finalizers.push(fn); },
    };

    plugins.extendContext(ctx);

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

        const durationMs = Date.now() - testStartTime;
        console.log(`    ${pc.green(pc.bold('PASSED'))} ${pc.dim(`(${formatDuration(durationMs)})`)}\n`);
        return { file, testName: testCase.name, passed: true, durationMs, plugin: pluginName };
    } catch (error) {
        const durationMs = Date.now() - testStartTime;
        const errorMsg = (error as Error).message;
        console.log(`    ${pc.red(pc.bold('FAILED'))} ${pc.dim(`(${formatDuration(durationMs)})`)}: ${pc.red(errorMsg)}\n`);
        return { file, testName: testCase.name, passed: false, durationMs, error: error as Error, plugin: pluginName };
    } finally {
        await session.disconnectAllBots();
        for (const { account, pool } of leasedAccounts) pool.release(account);
    }
}
