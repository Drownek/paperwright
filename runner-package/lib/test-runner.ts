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
 * Runs one test case end to end: creates the primary bot (firing `onPlayerCreate`),
 * builds `TestContext`, and sequences hooks in order — plugin beforeEach → spec beforeEach
 * → body → cleanup finalizers → spec afterEach → plugin afterEach. Finalizer errors are
 * logged but never flip the test result; spec afterEach errors do, matching the runner's
 * pre-plugin-host behavior.
 */
export async function runTestCase(params: RunTestCaseParams): Promise<TestResult> {
    const { file, testCase, session, plugins, connOpts, timeoutMs, pluginName = null } = params;

    console.log(`  ${pc.bold(`Test: ${testCase.name}`)}`);
    session.consoleLog.clear();

    const server = new ServerWrapper(session);
    const finalizers: Array<() => void | Promise<void>> = [];

    // Accounts leased from `session.env.accounts()` for this test, returned in the `finally`
    // below regardless of how the test ends.
    const leasedAccounts: Array<{ account: Account; pool: AccountPool }> = [];

    const createPlayer = async (options?: { username?: string }): Promise<PlayerWrapper> => {
        // An explicit username always bypasses the pool: it names a specific bot identity
        // the test wants, not "give me whatever account is free".
        const pool = options?.username ? null : session.env.accounts?.() ?? null;
        let account: Account;
        if (pool) {
            account = await pool.lease();
            leasedAccounts.push({ account, pool });
        } else {
            const uniqueId = randomUUID().split('-')[0];
            account = syntheticAccount(options?.username || `Test_${uniqueId}`);
        }
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
        return player;
    };

    const player = await createPlayer();
    const abortController = new AbortController();

    const ctx: TestContext = {
        player,
        server,
        createPlayer,
        signal: abortController.signal,
        cleanup: (fn: () => void | Promise<void>) => { finalizers.push(fn); },
    };

    plugins.extendContext(ctx);

    const testStartTime = Date.now();

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
