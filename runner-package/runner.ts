import { readdir } from 'fs/promises';
import { join, basename } from 'path';
import { pathToFileURL } from 'url';
import { randomUUID } from 'node:crypto';
import { install as installSourceMapSupport } from 'source-map-support';
import pc from 'picocolors';
import { ItemWrapper, GuiWrapper, LiveGuiHandle, GuiItemLocator } from './lib/wrappers.js';
import { PlayerWrapper } from './lib/player.js';
import { ServerWrapper } from './lib/server.js';
import { testRegistry, scopeStack } from './lib/test-registry.js';
import { Session } from './lib/session.js';
import { LocalEnvironment } from './lib/environments/local.js';
import { formatDuration, printTestSummary } from './lib/reporter.js';
import { loadRunnerConfig } from './lib/config.js';
import type { Environment } from './lib/environment.js';
import type { EnvironmentConfig, LocalEnvironmentConfig, RunnerConfig } from './lib/config.js';
import type { TestResult } from './lib/types.js';

// Enable source map support for accurate TypeScript stack traces
installSourceMapSupport();

// Re-export public API
export { ItemWrapper, GuiWrapper, LiveGuiHandle, GuiItemLocator };
export { PlayerWrapper } from './lib/player.js';
export { ServerWrapper } from './lib/server.js';
export { test, opTest, describe, beforeEach, afterEach } from './lib/test-registry.js';
export { expect } from './lib/matchers.js';
export { loadRunnerConfig, resolveSecret, isSecretRef } from './lib/config.js';
export type { RunnerConfig, EnvironmentConfig, TestsConfig, LocalEnvironmentConfig, SecretRef } from './lib/config.js';
export type { TestContext } from './lib/types.js';
export type { Environment, EnvironmentCapabilities, BotConnectionOptions } from './lib/environment.js';
export type { ServerConsole } from './lib/console.js';
export { Session } from './lib/session.js';

/** Only `local` is wired up yet; third-party modes arrive with the mode registry (phase 3). */
function resolveEnvironment(cfg: EnvironmentConfig): Environment {
    if (cfg.mode !== 'local') {
        throw new Error(`Environment "${cfg.name}" uses mode "${cfg.mode}", which this runner cannot run yet.`);
    }
    return new LocalEnvironment(cfg.config as unknown as LocalEnvironmentConfig);
}

async function findSpecFiles(dir: string): Promise<string[]> {
    const results: string[] = [];
    for (const entry of await readdir(dir, { withFileTypes: true })) {
        if (entry.isDirectory() && entry.name !== 'node_modules' && entry.name !== '.git') {
            results.push(...await findSpecFiles(join(dir, entry.name)));
        } else if (entry.isFile() && entry.name.endsWith('.spec.js')) {
            results.push(join(dir, entry.name));
        }
    }
    return results;
}

export async function runTestSession(config: RunnerConfig = loadRunnerConfig()): Promise<void> {
    const testFileFilters = config.tests.include ?? null;
    const testNameFilters = config.tests.names ?? null;
    const testResults: TestResult[] = [];

    const env = resolveEnvironment(config.environment);
    const session = new Session(env);

    let exitCode = 0;

    await env.setup(session);
    session.refreshConsole();

    try {
        const connOpts = env.connection();

        let testFiles = await findSpecFiles(config.tests.dir || process.cwd());
        if (testFileFilters) {
            const patterns = testFileFilters;
            console.log(`${pc.dim(`Filtering test files with patterns: ${JSON.stringify(patterns)}`)}\n`);
            testFiles = testFiles.filter(file =>
                patterns.some(pattern => {
                    const fileName = basename(file).replace(/\.spec\.js$/, '');
                    const matches = fileName.includes(pattern) || file.includes(pattern);
                    console.log(pc.dim(`  Testing ${file} (basename: ${fileName}) against pattern "${pattern}": ${matches}`));
                    return matches;
                })
            );
        }

        console.log(`${pc.bold(`Found ${testFiles.length} test file(s)${testFileFilters ? ` matching filter: ${testFileFilters.join(',')}` : ''}`)}\n`);

        for (const file of testFiles) {
            console.log(`\n${pc.blue(pc.bold(`Running tests from: ${file}`))}`);

            testRegistry.length = 0;
            scopeStack.length = 0;
            scopeStack.push({ label: '', beforeHooks: [], afterHooks: [] });
            await import(pathToFileURL(file).href);

            for (const testCase of testRegistry) {
                if (testNameFilters) {
                    const matches = testNameFilters.some(pattern => testCase.name.includes(pattern));
                    if (!matches) {
                        console.log(pc.dim(`  Test: ${testCase.name} - SKIPPED (filter: ${testNameFilters.join(',')})`));
                        continue;
                    }
                }

                console.log(`  ${pc.bold(`Test: ${testCase.name}`)}`);

                session.consoleLog.clear();

                const server = new ServerWrapper(session);

                const createPlayer = async (options?: { username?: string }): Promise<PlayerWrapper> => {
                    const uniqueId = randomUUID().split('-')[0];
                    const botUsername = options?.username || `Test_${uniqueId}`;
                    console.log(`${pc.cyan('[Bot]')} Creating bot: ${pc.bold(botUsername)}`);

                    const bot = session.createBot({ ...connOpts, username: botUsername });

                    const player = new PlayerWrapper(bot, session);
                    player._captureSpawnPromise();
                    player.setServerWrapper(server);
                    player._setBotOptions(connOpts);

                    await player.join();
                    return player;
                };

                const player = await createPlayer();

                const testStartTime = Date.now();

                try {
                    const abortController = new AbortController();
                    const timeoutMs = config.tests.timeoutMs
                        ?? (process.env.TEST_TIMEOUT ? parseInt(process.env.TEST_TIMEOUT, 10) : 30000);
                    let timeoutHandle: ReturnType<typeof setTimeout>;
                    const timeoutPromise = new Promise<never>((_, reject) => {
                        timeoutHandle = setTimeout(() => {
                            abortController.abort();
                            reject(new Error(`Test timed out after ${timeoutMs}ms. You can increase this by setting the TEST_TIMEOUT environment variable.`));
                        }, timeoutMs);
                    });

                    await Promise.race([
                        testCase.fn({ player, server, createPlayer, signal: abortController.signal }).finally(() => clearTimeout(timeoutHandle)),
                        timeoutPromise
                    ]);

                    const durationMs = Date.now() - testStartTime;
                    console.log(`    ${pc.green(pc.bold('PASSED'))} ${pc.dim(`(${formatDuration(durationMs)})`)}\n`);
                    testResults.push({ file, testName: testCase.name, passed: true, durationMs });
                } catch (error) {
                    const durationMs = Date.now() - testStartTime;
                    const errorMsg = (error as Error).message;

                    console.log(`    ${pc.red(pc.bold('FAILED'))} ${pc.dim(`(${formatDuration(durationMs)})`)}: ${pc.red(errorMsg)}\n`);

                    testResults.push({
                        file,
                        testName: testCase.name,
                        passed: false,
                        durationMs,
                        error: error as Error
                    });
                } finally {
                    await session.disconnectAllBots();
                }
            }
        }

    } finally {
        await session.disconnectAllBots();
        await env.teardown();

        exitCode = printTestSummary(testResults);

        setTimeout(() => {
            process.exit(exitCode);
        }, 1000).unref();
    }
}

export { sleep, poll, waitForAssertion, waitUntil, waitForStable } from './lib/utils.js';
