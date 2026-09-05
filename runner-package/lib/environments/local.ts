import { spawn, ChildProcessWithoutNullStreams } from 'child_process';
import pc from 'picocolors';
import type { Environment, EnvironmentCapabilities, BotConnectionOptions } from '../environment.js';
import type { ServerConsole } from '../console.js';
import type { LocalEnvironmentConfig } from '../config.js';
import type { Session } from '../session.js';

const CAPABILITIES: EnvironmentCapabilities = {
    console: true,
    consoleOutput: 'full',
    op: true,
    freshState: true,
    arbitraryUsernames: true,
    lifecycle: true,
};

/** Talks to the Paper process over its stdin/stdout, same as the runner always has. */
class StdioConsole implements ServerConsole {
    readonly kind = 'stdio' as const;
    readonly output = 'full' as const;

    constructor(
        private readonly serverProcess: ChildProcessWithoutNullStreams,
    ) {}

    async probe(): Promise<boolean> {
        return this.serverProcess.exitCode === null && !this.serverProcess.killed;
    }

    execute(cmd: string): void {
        console.log(`${pc.yellow('[Server]')} ${pc.dim(`Executing: ${cmd}`)}`);
        this.serverProcess.stdin.write(cmd + '\n', (err) => {
            if (err) console.error(`[Server] Write error: ${err}`);
        });
    }

    /** stdio has no synchronous response channel, so we round-trip through a `/say` marker
     *  and poll the console log for it, the same trick `PlayerWrapper.executeAndSync` uses.
     *  Returns all lines produced between command submission and the sync marker.
     */
    async executeAndWait(cmd: string, timeoutMs: number = 5000): Promise<string> {
        const syncId = `sync_${randomUUID().split('-')[0]}`;
        const since = this.session.consoleLog.length;
        this.execute(cmd);
        this.execute(`say ${syncId}`);

        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
            const recent = this.session.consoleLog.slice(since);
            const syncIdx = recent.findIndex(l => l.includes(syncId));
            if (syncIdx !== -1) {
                return recent.slice(0, syncIdx).join('\n');
            }
            await new Promise(resolve => setTimeout(resolve, 50));
        }
        throw new Error(`Console command sync timed out for: ${cmd}`);
    }
}

/**
 * The mode that's been here all along: download Paper, patch configs (Gradle side),
 * spawn it, tear it down. Behavior is unchanged from the pre-Session runner.ts —
 * this class just gives it a home that isn't the top-level function body.
 */
export class LocalEnvironment implements Environment {
    readonly id = 'local';
    readonly capabilities = CAPABILITIES;

    private readonly config: LocalEnvironmentConfig;
    private serverProcess: ChildProcessWithoutNullStreams | null = null;
    private session: Session | null = null;
    private cleanupStarted = false;

    constructor(config: LocalEnvironmentConfig) {
        this.config = config;
    }

    async setup(session: Session): Promise<void> {
        this.session = session;

        const { serverJar, serverDir, javaPath } = this.config;
        if (!serverJar || !serverDir || !javaPath) {
            throw new Error('Environment config must provide serverJar, serverDir and javaPath');
        }

        console.log(`${pc.bold('Starting Paper server...')}`);
        const jvmArgs = this.config.jvmArgs ?? [];
        console.log(pc.dim(`JVM Arguments: ${jvmArgs.join(' ')}`));

        const serverProcess = spawn(javaPath, [...jvmArgs, '-jar', serverJar, '--nogui'], {
            cwd: serverDir,
            stdio: ['pipe', 'pipe', 'pipe'],
        });
        this.serverProcess = serverProcess;
        this._installProcessGuards(serverProcess);

        await this._waitForServerStart(serverProcess);
        console.log(`${pc.green(pc.bold('Server started successfully'))}\n`);

        serverProcess.stdout.on('data', (data: Buffer) => session.writeConsoleOutput(data));
        serverProcess.stderr.on('data', (data: Buffer) => session.writeConsoleOutput(data));
    }

    connection(): BotConnectionOptions {
        return {
            host: this.config.host ?? 'localhost',
            port: this.config.port ?? 25565,
            version: this.config.minecraftVersion ?? undefined,
            auth: 'offline',
        };
    }

    console(): ServerConsole | null {
        if (!this.serverProcess || !this.session) return null;
        return new StdioConsole(this.serverProcess);
    }

    async teardown(): Promise<void> {
        const serverProcess = this.serverProcess;
        if (!serverProcess) return;

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
    }

    private _waitForServerStart(serverProcess: ChildProcessWithoutNullStreams): Promise<void> {
        const session = this.session!;
        return new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                reject(new Error('Server failed to start within 120 seconds'));
            }, 120000);

            const dataHandler = (data: Buffer): void => {
                const output = data.toString();
                session.writeConsoleOutput(data);

                if (output.includes('Done (')) {
                    clearTimeout(timeout);
                    serverProcess.stdout.removeListener('data', dataHandler);
                    serverProcess.stderr.removeListener('data', stderrHandler);
                    setTimeout(resolve, 3000);
                }
            };

            const stderrHandler = (data: Buffer): void => {
                session.writeConsoleOutput(data);
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

    /**
     * Kills the Paper process tree if our own process dies unexpectedly — Gradle task
     * cancelled from the IDE, SIGKILL from upstream, etc. Otherwise java.exe keeps
     * running and holds run/logs/latest.log open, breaking the next clean on Windows.
     */
    private _installProcessGuards(serverProcess: ChildProcessWithoutNullStreams): void {
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

        const emergencyShutdown = (signal: string): void => {
            if (this.cleanupStarted) return;
            this.cleanupStarted = true;
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
    }
}
