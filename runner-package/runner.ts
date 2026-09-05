import { readdir } from 'fs/promises';
import { join, basename } from 'path';
import { pathToFileURL } from 'url';
import { install as installSourceMapSupport } from 'source-map-support';
import pc from 'picocolors';
import { ItemWrapper, GuiWrapper, LiveGuiHandle, GuiItemLocator } from './lib/wrappers.js';
import { testRegistry, resetRegistry } from './lib/test-registry.js';
import { Session } from './lib/session.js';
import { PluginHost } from './lib/plugin-host.js';
import { runSerialBlock, runTestCase, runConcurrentSerialBlock, runConcurrentTestCase } from './lib/test-runner.js';
import { skipReasonForOptions } from './lib/skip-reason.js';
import { LocalEnvironment } from './lib/environments/local.js';
import { externalEnvironment } from './lib/environments/external.js';
import { PlayerWrapper } from './lib/player.js';
import { printTestSummary, writeJsonReport, writeJUnitReport } from './lib/reporter.js';
import { loadRunnerConfig } from './lib/config.js';
import { importOptionalPackage } from './lib/utils.js';
import type { Environment } from './lib/environment.js';
import type { EnvironmentConfig, LocalEnvironmentConfig, RunnerConfig } from './lib/config.js';
import type { ExternalEnvironmentConfig } from './lib/environments/external.js';
import type { TestResult } from './lib/types.js';
import type { SerialBlock, TestCase, RegistryItem } from './lib/test-registry.js';
import type { Account, AccountPool } from './lib/account.js';

// Enable source map support for accurate TypeScript stack traces
installSourceMapSupport();

// Re-export public API
export { ItemWrapper, GuiWrapper, LiveGuiHandle, GuiItemLocator };
export { PlayerWrapper };
export { ServerWrapper } from './lib/server.js';
export { test, opTest, describe, beforeEach, afterEach } from './lib/test-registry.js';
export type { TestOptions, TestCase, SerialOptions, SerialBlock } from './lib/test-registry.js';
export { expect } from './lib/matchers.js';
export { loadRunnerConfig, resolveSecret, isSecretRef } from './lib/config.js';
export type { RunnerConfig, EnvironmentConfig, TestsConfig, LocalEnvironmentConfig, SecretRef, PluginConfig } from './lib/config.js';
export type { TestContext, TestResult } from './lib/types.js';
export type { Environment, EnvironmentCapabilities, BotConnectionOptions } from './lib/environment.js';
export type { ServerConsole } from './lib/console.js';
export { Session } from './lib/session.js';
export { PluginHost } from './lib/plugin-host.js';
export { definePlugin, PLUGIN_API_VERSION } from './lib/plugin.js';
export type { PlugwrightPlugin, SessionContext, CleanupContext, PluginTestRef, MatcherFn } from './lib/plugin.js';
export { AccountPool } from './lib/account.js';
export type { Account, AccountsConfig } from './lib/account.js';
export { externalEnvironment };
export type { ExternalEnvironmentConfig, ExternalConsoleChannelConfig } from './lib/environments/external.js';

/**
 * `local` and `external` are built into this package; anything else is a third-party mode,
 * loaded through the `runtime` reference the Gradle plugin wrote into the config.
 */
async function resolveEnvironment(cfg: EnvironmentConfig): Promise<Environment> {
    if (cfg.mode === 'local') {
        return new LocalEnvironment(cfg.config as unknown as LocalEnvironmentConfig);
    }
    if (cfg.mode === 'external') {
        return externalEnvironment(cfg.config as unknown as ExternalEnvironmentConfig);
    }
    if (cfg.runtime) {
        let mod: any;
        try {
            mod = await importOptionalPackage(cfg.runtime.package);
        } catch (error) {
            throw new Error(
                `Environment "${cfg.name}" needs package "${cfg.runtime.package}", which failed to load: ` +
                `${(error as Error).message}`
            );
        }
        const exportName = cfg.runtime.export ?? 'default';
        const factory = mod[exportName];
        if (typeof factory !== 'function') {
            throw new Error(`Package "${cfg.runtime.package}" has no export "${exportName}" for environment "${cfg.name}"`);
        }
        return factory(cfg.config) as Environment;
    }
    throw new Error(`Environment "${cfg.name}" uses mode "${cfg.mode}", which this runner cannot run yet.`);
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
    const testNameExcludes = config.tests.exclude ?? null;
    const timeoutMs = config.tests.timeoutMs
        ?? (process.env.TEST_TIMEOUT ? parseInt(process.env.TEST_TIMEOUT, 10) : 30000);
    const testResults: TestResult[] = [];

    const env = await resolveEnvironment(config.environment);
    const session = new Session(env);
    const plugins = new PluginHost();
    await plugins.load(config.plugins ?? []);
    // Must happen before the first spec file is imported — see PluginHost.registerMatchers.
    plugins.registerMatchers();
    // Wired before env.setup(): an environment's own console channel can be a bot that needs
    // to authenticate during setup() (see AdminBotConsole), which goes through this same hook.
    session.onPlayerCreate = (player, ctx) => plugins.onPlayerCreate(player, ctx);

    let exitCode = 0;

    await env.setup(session);
    session.refreshConsole();
    await plugins.setup(session);

    try {
        const connOpts = env.connection();

        /** Why a test should not run, or null to run it. Checked in order: name exclude,
         *  name filter, declared `environments`, declared `requires`. A skip always lands
         *  in the report with its reason — a silent skip on an external stand would look
         *  like coverage that isn't really there. */
        function skipReasonFor(testCase: TestCase): string | null {
            if (testNameExcludes?.some(pattern => testCase.name.includes(pattern))) {
                return `excluded by tests.exclude (matches "${testNameExcludes.join(',')}")`;
            }
            if (testNameFilters && !testNameFilters.some(pattern => testCase.name.includes(pattern))) {
                return `filtered out by tests.names (${testNameFilters.join(',')})`;
            }
            return skipReasonForOptions(env, config.environment.name, testCase.requires, testCase.environments);
        }

        /** Why a whole `describe.serial` block should not run. The block's own `requires` /
         *  `environments` come first, then the tests inside it: a filter that takes out one step
         *  of a chain leaves the rest asserting against state nothing produced, so it takes out
         *  the block instead. */
        function blockSkipReason(block: SerialBlock): string | null {
            const own = skipReasonForOptions(env, config.environment.name, block.requires, block.environments);
            if (own) return own;
            for (const testCase of block.tests) {
                const reason = skipReasonFor(testCase);
                if (reason) return `"${testCase.name}" ${reason}, and a serial block runs whole or not at all`;
            }
            return null;
        }

        /** One imported spec file's registered tests, snapshotted right after import so its
         *  concurrency values can be validated before any file's tests run — re-importing later
         *  to re-check wouldn't work anyway: ESM caches the module, so a second `import()` of
         *  the same file wouldn't re-run its top-level `test()`/`describe()` calls. */
        interface LoadedFile {
            file: string;
            pluginName: string | null;
            items: RegistryItem[];
        }

        async function loadFile(file: string, pluginName: string | null): Promise<LoadedFile> {
            resetRegistry();
            await import(pathToFileURL(file).href);
            return { file, pluginName, items: [...testRegistry] };
        }

        /** Fails fast, before any test in the session runs, on a `concurrency` the account pool
         *  here can't satisfy — rather than the test itself blocking on its Nth `pool.lease()`. An
         *  environment with no pool (e.g. `LocalMode`) mints a synthetic throwaway account per
         *  connection instead of leasing one, so there's no pool capacity to check against; its
         *  ceiling is the server's own `max-players`, which is on the operator, not this check. */
        function validateConcurrency(loaded: LoadedFile[]): void {
            const pool = env.accounts?.() ?? null;
            if (!pool) return;
            const capacity = pool.capacity();

            for (const { file, items } of loaded) {
                for (const item of items) {
                    const [kind, name, concurrency] = item.kind === 'serial'
                        ? ['describe.serial', item.block.name, item.block.concurrency] as const
                        : ['test', item.testCase.name, item.testCase.concurrency] as const;
                    if (concurrency <= 1) continue;
                    if (concurrency > capacity) {
                        throw new Error(
                            `${kind} "${name}" (${file}) declares concurrency: ${concurrency}, exceeding the ` +
                            `account pool's capacity (${capacity}). Reduce concurrency or grow the pool.`
                        );
                    }
                }
            }
        }

        /** Runs everything one loaded file registered, appending results to `testResults`.
         *  Shared by user specs and every plugin-inherited test file. */
        async function runLoadedFile(loaded: LoadedFile): Promise<void> {
            const { file, pluginName, items } = loaded;

            for (const item of items) {
                if (item.kind === 'serial') {
                    const { block } = item;
                    const skipReason = blockSkipReason(block);
                    if (skipReason) {
                        console.log(pc.dim(`  Serial block: ${block.name} - SKIPPED (${skipReason})`));
                        for (const testCase of block.tests) {
                            testResults.push({ file, testName: testCase.name, passed: true, durationMs: 0, skipped: true, skipReason, plugin: pluginName });
                        }
                        continue;
                    }

                    const results = block.concurrency > 1
                        ? await runConcurrentSerialBlock({ file, block, session, plugins, connOpts, timeoutMs, pluginName, concurrency: block.concurrency })
                        : await runSerialBlock({ file, block, session, plugins, connOpts, timeoutMs, pluginName });
                    testResults.push(...results);
                    continue;
                }

                const { testCase } = item;
                const skipReason = skipReasonFor(testCase);
                if (skipReason) {
                    console.log(pc.dim(`  Test: ${testCase.name} - SKIPPED (${skipReason})`));
                    testResults.push({ file, testName: testCase.name, passed: true, durationMs: 0, skipped: true, skipReason, plugin: pluginName });
                    continue;
                }

                const result = testCase.concurrency > 1
                    ? await runConcurrentTestCase({ file, testCase, session, plugins, connOpts, timeoutMs, pluginName, concurrency: testCase.concurrency })
                    : await runTestCase({ file, testCase, session, plugins, connOpts, timeoutMs, pluginName });
                testResults.push(result);
            }
        }

        const preflightEntries = [...plugins.testFiles('preflight')];
        const loadedPreflight: LoadedFile[] = [];
        for (const { file, pluginName } of preflightEntries) loadedPreflight.push(await loadFile(file, pluginName));

        // Preflight files are loaded and validated on their own, before any main/suite spec
        // file is imported — importing those here would run their top-level code ahead of
        // preflight, against whatever state preflight was going to set up during execution.
        validateConcurrency(loadedPreflight);

        // Preflight: plugin auth/setup tests, run before anything else. A failure aborts the
        // whole session.
        for (const loaded of loadedPreflight) {
            console.log(`\n${pc.blue(pc.bold(`Running preflight tests from: ${loaded.file} ${pc.dim(`(plugin ${loaded.pluginName})`)}`))}`);
            const before = testResults.length;
            await runLoadedFile(loaded);
            const failed = testResults.slice(before).find(r => !r.skipped && !r.passed);
            if (failed) {
                throw new Error(`Preflight test "${failed.testName}" failed (plugin ${loaded.pluginName}): ${failed.error?.message ?? 'unknown error'}`);
            }
        }

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
        const loadedMain: LoadedFile[] = [];
        for (const file of testFiles) loadedMain.push(await loadFile(file, null));

        const suiteEntries = [...plugins.testFiles('suite')];
        const loadedSuite: LoadedFile[] = [];
        for (const { file, pluginName } of suiteEntries) loadedSuite.push(await loadFile(file, pluginName));

        // Main and suite files are loaded (imported once, registrations snapshotted) before any
        // of them runs, so a misconfigured `concurrency` aborts here instead of after burning
        // time on earlier tests. Preflight has already run by this point, so this no longer
        // imports them ahead of the state preflight sets up.
        validateConcurrency([...loadedMain, ...loadedSuite]);

        console.log(`${pc.bold(`Found ${loadedMain.length} test file(s)${testFileFilters ? ` matching filter: ${testFileFilters.join(',')}` : ''}`)}\n`);

        for (const loaded of loadedMain) {
            console.log(`\n${pc.blue(pc.bold(`Running tests from: ${loaded.file}`))}`);
            await runLoadedFile(loaded);
        }

        // Suite: plugin tests that run alongside user specs, tagged with the plugin's name.
        for (const loaded of loadedSuite) {
            console.log(`\n${pc.blue(pc.bold(`Running tests from: ${loaded.file} ${pc.dim(`(plugin ${loaded.pluginName})`)}`))}`);
            await runLoadedFile(loaded);
        }

    } finally {
        await plugins.runCleanup(session);
        await plugins.teardown();
        await session.disconnectAllBots();
        await env.teardown();

        if (config.reports?.json) {
            writeJsonReport(config.reports.json, config.environment.name, testResults);
            console.log(pc.dim(`JSON report: ${config.reports.json}`));
        }
        if (config.reports?.junit) {
            writeJUnitReport(config.reports.junit, config.environment.name, testResults);
            console.log(pc.dim(`JUnit report: ${config.reports.junit}`));
        }

        exitCode = printTestSummary(testResults);

        setTimeout(() => {
            process.exit(exitCode);
        }, 1000).unref();
    }
}

export { sleep, poll, waitForAssertion, waitUntil, waitForStable } from './lib/utils.js';

/**
 * `--ping`: connects to the environment, probes its declared console channel(s), and — if the
 * environment has an account pool — leases one account and checks that it authenticates. No
 * spec files run. Exits non-zero (after a readable diagnosis) on any problem, so it's safe to
 * gate a build on.
 */
export async function runPingSession(config: RunnerConfig = loadRunnerConfig()): Promise<void> {
    console.log(pc.bold(`plugwright ping: environment "${config.environment.name}" (${config.environment.mode})`));

    const env = await resolveEnvironment(config.environment);
    const session = new Session(env);
    const plugins = new PluginHost();
    await plugins.load(config.plugins ?? []);
    plugins.registerMatchers();
    session.onPlayerCreate = (player, ctx) => plugins.onPlayerCreate(player, ctx);

    const problems: string[] = [];
    let account: Account | undefined;
    let pool: AccountPool | null = null;

    try {
        await env.setup(session);
        session.refreshConsole();
        await plugins.setup(session);

        if (env.capabilities.console) {
            console.log(pc.green(`console: reachable (${session.console?.kind}, output=${session.console?.output})`));
        } else {
            console.log(pc.yellow('console: unavailable'));
            problems.push('no console channel could be reached');
        }

        pool = env.accounts?.() ?? null;
        if (pool) {
            try {
                account = await pool.lease();
                await env.beforeJoin?.();
                const connOpts = env.connection();
                const bot = session.createBot({ ...connOpts, auth: account.auth, username: account.username });
                const player = new PlayerWrapper(bot, session);
                player._captureSpawnPromise();
                player._setBotOptions({ ...connOpts, auth: account.auth });
                player._setAccount(account);
                await player.join();
                console.log(pc.green(`auth: "${account.username}" connected and authenticated`));
                await session.disconnectBot(bot, account.username);
                session.removeBot(bot);
            } catch (error) {
                problems.push(`auth check failed: ${(error as Error).message}`);
            }
        } else {
            console.log(pc.dim('auth: no account pool configured for this environment, skipped'));
        }
    } catch (error) {
        problems.push((error as Error).message);
    } finally {
        if (account && pool) pool.release(account);
        await plugins.teardown();
        await session.disconnectAllBots();
        await env.teardown();
    }

    let exitCode = 0;
    if (problems.length > 0) {
        console.log(pc.red('\nplugwrightPing failed:'));
        for (const problem of problems) console.log(pc.red(`  - ${problem}`));
        exitCode = 1;
    } else {
        console.log(pc.green('\nplugwrightPing: environment is reachable'));
    }

    // Both: the unref'd timer only fires if something else is still holding the loop
    // open (a lingering socket); process.exitCode carries the result when it isn't.
    process.exitCode = exitCode;
    setTimeout(() => process.exit(exitCode), 500).unref();
}

