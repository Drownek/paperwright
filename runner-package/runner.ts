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
import { printTestSummary, writeJsonReport, writeJUnitReport } from './lib/reporter.js';
import { loadRunnerConfig } from './lib/config.js';
import type { Environment } from './lib/environment.js';
import type { EnvironmentConfig, LocalEnvironmentConfig, RunnerConfig } from './lib/config.js';
import type { TestResult } from './lib/types.js';
import type { TestCase } from './lib/test-registry.js';

// Enable source map support for accurate TypeScript stack traces
installSourceMapSupport();

// Re-export public API
export { ItemWrapper, GuiWrapper, LiveGuiHandle, GuiItemLocator };
export { PlayerWrapper } from './lib/player.js';
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
export type { Account } from './lib/account.js';
export { CleanupJournal } from './lib/journal.js';
export type { JournalEntry } from './lib/journal.js';

/** Only `local` is wired up yet; third-party modes arrive with the mode registry (phase 3). */
function resolveEnvironment(cfg: EnvironmentConfig): Environment {
    if (cfg.mode !== 'local') {
        throw new Error(`Environment "${cfg.name}" uses mode "${cfg.mode}", which this runner cannot run yet.`);
    }
    return new LocalEnvironment(cfg.config as unknown as LocalEnvironmentConfig);
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

    const env = resolveEnvironment(config.environment);
    const session = new Session(env, config.journal ?? null);
    const plugins = new PluginHost();
    await plugins.load(config.plugins ?? []);
    // Must happen before the first spec file is imported — see PluginHost.registerMatchers.
    plugins.registerMatchers();

    let exitCode = 0;

    await env.setup(session);
    session.refreshConsole();
    await plugins.setup(session);
    session.onPlayerCreate = (player, ctx) => plugins.onPlayerCreate(player, ctx);

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
