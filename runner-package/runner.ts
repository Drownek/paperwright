import { spawn, ChildProcessWithoutNullStreams } from 'child_process';
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
import { serverConsoleBuffer, createBot, disconnectAllBots, writeMcOutput } from './lib/bot-utils.js';
import { formatDuration, printTestSummary } from './lib/reporter.js';
import type { TestResult } from './lib/types.js';

// Enable source map support for accurate TypeScript stack traces
installSourceMapSupport();

// Re-export public API
export { ItemWrapper, GuiWrapper, LiveGuiHandle, GuiItemLocator };
export { PlayerWrapper } from './lib/player.js';
export { ServerWrapper } from './lib/server.js';
export { test, opTest, describe, beforeEach, afterEach } from './lib/test-registry.js';
export { expect } from './lib/matchers.js';
export type { TestContext } from './lib/types.js';

async function waitForServerStart(serverProcess: ChildProcessWithoutNullStreams): Promise<void> {
    return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
            reject(new Error('Server failed to start within 120 seconds'));
        }, 120000);

        const dataHandler = (data: Buffer): void => {
            const output = data.toString();
            writeMcOutput(data);

            if (output.includes('Done (')) {
                clearTimeout(timeout);
                serverProcess.stdout.removeListener('data', dataHandler);
                serverProcess.stderr.removeListener('data', stderrHandler);
                setTimeout(resolve, 3000);
            }
        };

        const stderrHandler = (data: Buffer): void => {
            writeMcOutput(data);
        };

        serverProcess.stdout.on('data', dataHandler);
        serverProcess.stderr.on('data', stderrHandler);

        serverProcess.on('error', (err: Error) => {
            clearTimeout(timeout);
            reject(new Error(`Failed to start server: ${err.message}`));
        });

        serverProcess.on('exit', (code: number | null) => {
            if (code !== null && code !== 0) {
                clearTimeout(timeout);
                reject(new Error(`Server exited with code ${code} before becoming ready`));
            }
        });
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

export async function runTestSession(): Promise<void> {
    const serverJar = process.env.SERVER_JAR;
    const serverDir = process.env.SERVER_DIR;
    const javaPath = process.env.JAVA_PATH;
    const testFileFilter = process.env.TEST_FILES;
    const testNameFilter = process.env.TEST_NAMES;
    const testResults: TestResult[] = [];

    if (!serverJar || !serverDir || !javaPath) {
        throw new Error('SERVER_JAR, JAVA_PATH and SERVER_DIR environment variables must be set');
    }

    let exitCode = 0;

    console.log(`${pc.bold('Starting Paper server...')}`);

    const jvmArgsString = process.env.JVM_ARGS || '';
    const jvmArgs = jvmArgsString.split(' ').filter(arg => arg.trim() !== '');

    console.log(pc.dim(`JVM Arguments: ${jvmArgs.join(' ')}`));

    const serverProcess = spawn(javaPath!, [...jvmArgs, '-jar', serverJar, '--nogui'], {
        cwd: serverDir,
        stdio: ['pipe', 'pipe', 'pipe']
    });

    // Ensure the Paper server dies if our runner is killed (e.g. Gradle task
    // cancelled from the IDE). Otherwise the java.exe keeps running and holds
    // run/logs/latest.log open, breaking the next plugwrightClean on Windows.
    const killServerTree = (): void => {
        if (!serverProcess.pid || serverProcess.killed || serverProcess.exitCode !== null) return;
        try {
            if (process.platform === 'win32') {
                // taskkill recursively kills the whole java process tree.
                spawn('taskkill', ['/F', '/T', '/PID', String(serverProcess.pid)], {
                    stdio: 'ignore',
                    windowsHide: true,
                }).on('error', () => { /* best effort */ });
            } else {
                serverProcess.kill('SIGKILL');
            }
        } catch {
            /* best effort */
        }
    };

    let cleanupStarted = false;
    const emergencyShutdown = (signal: string): void => {
        if (cleanupStarted) return;
        cleanupStarted = true;
        console.log(pc.yellow(`\n[runner] Received ${signal}, killing Paper server...`));
        killServerTree();
        // Give taskkill a moment, then exit.
        setTimeout(() => process.exit(1), 500).unref();
    };

    process.on('SIGINT', () => emergencyShutdown('SIGINT'));
    process.on('SIGTERM', () => emergencyShutdown('SIGTERM'));
    process.on('SIGHUP', () => emergencyShutdown('SIGHUP'));
    if (process.platform === 'win32') {
        process.on('SIGBREAK', () => emergencyShutdown('SIGBREAK'));
    }
    // Last-resort safety net: if this node process exits for any reason while
    // the server is still alive, try to take it down with us.
    process.on('exit', () => killServerTree());
    // On Windows, when the parent (Gradle) is killed abruptly, signals are not
    // delivered but our stdin pipe closes. Use that as a death signal.
    if (process.stdin && typeof process.stdin.on === 'function') {
        process.stdin.on('close', () => emergencyShutdown('stdin-close'));
        process.stdin.on('end', () => emergencyShutdown('stdin-end'));
        // stdin must be resumed for 'end'/'close' to fire on a piped stdin.
        try { process.stdin.resume(); } catch { /* ignore */ }
    }

    try {
        await waitForServerStart(serverProcess);
        console.log(`${pc.green(pc.bold('Server started successfully'))}\n`);

        serverProcess.stdout.on('data', writeMcOutput);
        serverProcess.stderr.on('data', writeMcOutput);

        let testFiles = await findSpecFiles(process.cwd());
        if (testFileFilter) {
            const patterns = testFileFilter.split(',').map(p => p.trim());
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

        console.log(`${pc.bold(`Found ${testFiles.length} test file(s)${testFileFilter ? ` matching filter: ${testFileFilter}` : ''}`)}\n`);

        for (const file of testFiles) {
            console.log(`\n${pc.blue(pc.bold(`Running tests from: ${file}`))}`);

            testRegistry.length = 0;
            scopeStack.length = 0;
            scopeStack.push({ label: '', beforeHooks: [], afterHooks: [] });
            await import(pathToFileURL(file).href);

            for (const testCase of testRegistry) {
                if (testNameFilter) {
                    const patterns = testNameFilter.split(',').map(p => p.trim());
                    const matches = patterns.some(pattern => testCase.name.includes(pattern));
                    if (!matches) {
                        console.log(pc.dim(`  Test: ${testCase.name} - SKIPPED (filter: ${testNameFilter})`));
                        continue;
                    }
                }

                console.log(`  ${pc.bold(`Test: ${testCase.name}`)}`);

                serverConsoleBuffer.length = 0;

                const server = new ServerWrapper((cmd: string) => {
                    console.log(`${pc.yellow('[Server]')} ${pc.dim(`Executing: ${cmd}`)}`);
                    serverProcess.stdin.write(cmd + '\n', (err) => {
                        if (err) console.error(`[Server] Write error: ${err}`);
                    });
                });

                const createPlayer = async (options?: { username?: string }): Promise<PlayerWrapper> => {
                    const uniqueId = randomUUID().split('-')[0];
                    const botUsername = options?.username || `Test_${uniqueId}`;
                    console.log(`${pc.cyan('[Bot]')} Creating bot: ${pc.bold(botUsername)}`);

                    let mineflayerVersion = process.env.MC_VERSION;
                    if (mineflayerVersion && mineflayerVersion.startsWith('26.1.')) {
                        mineflayerVersion = '26.1';
                    }

                    const bot = createBot({
                        host: 'localhost',
                        port: 25565,
                        username: botUsername,
                        version: mineflayerVersion,
                        auth: 'offline',
                    });

                    const player = new PlayerWrapper(bot);
                    player._captureSpawnPromise();
                    player.setServerWrapper(server);
                    player._setBotOptions({
                        host: 'localhost',
                        port: 25565,
                        version: mineflayerVersion,
                        auth: 'offline',
                    });

                    await player.join();
                    return player;
                };

                const player = await createPlayer();

                const testStartTime = Date.now();

                try {
                    const abortController = new AbortController();
                    const timeoutMs = process.env.TEST_TIMEOUT ? parseInt(process.env.TEST_TIMEOUT, 10) : 30000;
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
                    await disconnectAllBots();
                }
            }
        }

    } finally {
        await disconnectAllBots();

        // Stop the server
        if (serverProcess.exitCode === null && !serverProcess.killed) {
            try {
                serverProcess.stdin.write('stop\n');
            } catch (err) {
                console.log(pc.yellow(`[WARNING] Failed to send stop command to server: ${(err as Error).message}`));
            }
        }

        await new Promise<void>((resolve) => {
            const timeout = setTimeout(() => {
                console.log(pc.yellow('[WARNING] Server did not stop gracefully, forcing shutdown...'));
                serverProcess.kill();
                resolve();
            }, 30000);

            serverProcess.once('exit', (code) => {
                clearTimeout(timeout);
                if (code !== 0) {
                    console.log(pc.yellow(`[WARNING] Server exited with code: ${code}`));
                }
                resolve();
            });
        });

        serverProcess.removeAllListeners();
        serverProcess.stdin.end();
        serverProcess.stdout.destroy();
        serverProcess.stderr.destroy();

        exitCode = printTestSummary(testResults);

        setTimeout(() => {
            process.exit(exitCode);
        }, 1000).unref();
    }
}

export { sleep, poll, waitForAssertion, waitUntil, waitForStable } from './lib/utils.js';
