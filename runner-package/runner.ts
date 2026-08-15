import { readdir } from 'fs/promises';
import { join, basename } from 'path';
import { pathToFileURL } from 'url';
import { install as installSourceMapSupport } from 'source-map-support';
import pc from 'picocolors';
import { ItemWrapper, GuiWrapper, LiveGuiHandle, GuiItemLocator } from './lib/wrappers.js';
import { testRegistry, resetRegistry } from './lib/test-registry.js';
import { Session } from './lib/session.js';
import { PluginHost } from './lib/plugin-host.js';
import { runTestCase } from './lib/test-runner.js';
import { LocalEnvironment } from './lib/environments/local.js';
import { externalEnvironment } from './lib/environments/external.js';
import { PlayerWrapper } from './lib/player.js';
import { printTestSummary, writeJsonReport, writeJUnitReport } from './lib/reporter.js';
import { loadRunnerConfig } from './lib/config.js';
import type { Environment } from './lib/environment.js';
import type { EnvironmentConfig, LocalEnvironmentConfig, RunnerConfig } from './lib/config.js';
import type { ExternalEnvironmentConfig } from './lib/environments/external.js';
import type { TestResult } from './lib/types.js';
import type { TestCase } from './lib/test-registry.js';
import type { Account, AccountPool } from './lib/account.js';

// Enable source map support for accurate TypeScript stack traces
installSourceMapSupport();

// Re-export public API
export { ItemWrapper, GuiWrapper, LiveGuiHandle, GuiItemLocator };
export { PlayerWrapper };
export { ServerWrapper } from './lib/server.js';
export { test, opTest, describe, beforeEach, afterEach } from './lib/test-registry.js';
export type { TestOptions, TestCase } from './lib/test-registry.js';
export { expect } from './lib/matchers.js';
export { loadRunnerConfig, resolveSecret, isSecretRef } from './lib/config.js';
export type { RunnerConfig, EnvironmentConfig, TestsConfig, LocalEnvironmentConfig, SecretRef, PluginConfig } from './lib/config.js';
export type { TestContext } from './lib/types.js';
export type { Environment, EnvironmentCapabilities, BotConnectionOptions } from './lib/environment.js';
export type { ServerConsole } from './lib/console.js';
export { Session } from './lib/session.js';
export { PluginHost } from './lib/plugin-host.js';
export { definePlugin, PLUGIN_API_VERSION } from './lib/plugin.js';
export type { PlugwrightPlugin, SessionContext, CleanupContext, PluginTestRef, MatcherFn } from './lib/plugin.js';
export { AccountPool } from './lib/account.js';
export type { Account, AccountsConfig } from './lib/account.js';
export { AdminBotConsole } from './lib/admin-bot-console.js';
export { CleanupJournal } from './lib/journal.js';
export type { JournalEntry } from './lib/journal.js';
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
            mod = await import(cfg.runtime.package);
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

/** Capability keys from `testCase.requires` that `env` does not actually satisfy. A
 *  value of `false`, `'none'`, or an absent key all count as unmet. */
function missingCapabilities(env: Environment, required: string[]): string[] {
    const capabilities = env.capabilities as unknown as Record<string, unknown>;
    return required.filter(key => {
        const value = capabilities[key];
        return value === false || value === 'none' || value === undefined;
    });
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
    const session = new Session(env, config.journal ?? null);
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
            if (testCase.environments && !testCase.environments.includes(config.environment.name)) {
                return `requires environment in [${testCase.environments.join(', ')}], running "${config.environment.name}"`;
            }
            const missing = missingCapabilities(env, testCase.requires);
            if (missing.length > 0) {
                return `requires capability [${missing.join(', ')}], unavailable on "${config.environment.name}"`;
            }
            return null;
        }

        /** Imports one compiled spec file (a fresh `testRegistry`) and runs everything it
         *  registered, appending results to `testResults`. Shared by user specs and every
         *  plugin-inherited test file. */
        async function runFile(file: string, pluginName: string | null): Promise<void> {
            resetRegistry();
            await import(pathToFileURL(file).href);

            for (const testCase of testRegistry) {
                const skipReason = skipReasonFor(testCase);
                if (skipReason) {
                    console.log(pc.dim(`  Test: ${testCase.name} - SKIPPED (${skipReason})`));
                    testResults.push({ file, testName: testCase.name, passed: true, durationMs: 0, skipped: true, skipReason, plugin: pluginName });
                    continue;
                }

                const result = await runTestCase({ file, testCase, session, plugins, connOpts, timeoutMs, pluginName });
                testResults.push(result);
            }
        }

        // Preflight: plugin auth/setup tests, run before anything else. A failure aborts the
        // whole session.
        for (const { file, pluginName } of plugins.testFiles('preflight')) {
            console.log(`\n${pc.blue(pc.bold(`Running preflight tests from: ${file} ${pc.dim(`(plugin ${pluginName})`)}`))}`);
            const before = testResults.length;
            await runFile(file, pluginName);
            const failed = testResults.slice(before).find(r => !r.skipped && !r.passed);
            if (failed) {
                throw new Error(`Preflight test "${failed.testName}" failed (plugin ${pluginName}): ${failed.error?.message ?? 'unknown error'}`);
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

        console.log(`${pc.bold(`Found ${testFiles.length} test file(s)${testFileFilters ? ` matching filter: ${testFileFilters.join(',')}` : ''}`)}\n`);

        for (const file of testFiles) {
            console.log(`\n${pc.blue(pc.bold(`Running tests from: ${file}`))}`);
            await runFile(file, null);
        }

        // Suite: plugin tests that run alongside user specs, tagged with the plugin's name.
        for (const { file, pluginName } of plugins.testFiles('suite')) {
            console.log(`\n${pc.blue(pc.bold(`Running tests from: ${file} ${pc.dim(`(plugin ${pluginName})`)}`))}`);
            await runFile(file, pluginName);
        }

    } finally {
        await plugins.runCleanup(session, 'session');
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
    const session = new Session(env, null);
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

/**
 * `--cleanup`: runs every loaded plugin's `cleanup({ scope: 'manual' })` handler and reports
 * what the crash-recovery journal still has outstanding afterward. Replaying journal entries
 * is the plugin's job — it owns what a typed entry means — this only gives it the chance.
 */
export async function runCleanupSession(config: RunnerConfig = loadRunnerConfig()): Promise<void> {
    console.log(pc.bold(`plugwright cleanup: environment "${config.environment.name}"`));

    const env = await resolveEnvironment(config.environment);
    const session = new Session(env, config.journal ?? null);
    const plugins = new PluginHost();
    await plugins.load(config.plugins ?? []);
    plugins.registerMatchers();

    let exitCode = 0;
    try {
        const outstandingBefore = session.journal.outstanding();
        console.log(pc.dim(`journal: ${outstandingBefore.length} outstanding entr${outstandingBefore.length === 1 ? 'y' : 'ies'}`));

        await env.setup(session);
        session.refreshConsole();
        await plugins.setup(session);

        await plugins.runCleanup(session, 'manual');

        const outstandingAfter = session.journal.outstanding();
        if (outstandingAfter.length > 0) {
            console.log(pc.yellow(`journal: ${outstandingAfter.length} entr${outstandingAfter.length === 1 ? 'y' : 'ies'} still outstanding after cleanup`));
            for (const entry of outstandingAfter) console.log(pc.yellow(`  - ${JSON.stringify(entry)}`));
        } else {
            console.log(pc.green('journal: clean'));
        }
    } catch (error) {
        console.error(pc.red(`cleanup failed: ${(error as Error).message}`));
        exitCode = 1;
    } finally {
        await plugins.teardown();
        await session.disconnectAllBots();
        await env.teardown();
    }

    // Both: the unref'd timer only fires if something else is still holding the loop
    // open (a lingering socket); process.exitCode carries the result when it isn't.
    process.exitCode = exitCode;
    setTimeout(() => process.exit(exitCode), 500).unref();
}
