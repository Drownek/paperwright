import mineflayer, { Bot } from 'mineflayer';
import pc from 'picocolors';
import type { Environment, BotConnectionOptions } from './environment.js';
import type { ServerConsole } from './console.js';
import type { PlayerWrapper } from './player.js';
import type { Account } from './account.js';

/**
 * Append-only line buffer. Replaces the old module-level `string[]` singletons
 * (`messageBuffer`, `serverConsoleBuffer`) that a session's buffers used to be.
 */
export class MessageBuffer {
    private lines: string[] = [];

    push(line: string): void {
        this.lines.push(line);
    }

    get length(): number {
        return this.lines.length;
    }

    clear(): void {
        this.lines.length = 0;
    }

    slice(start?: number, end?: number): string[] {
        return this.lines.slice(start, end);
    }

    find(predicate: (line: string) => boolean): string | undefined {
        return this.lines.find(predicate);
    }

    some(predicate: (line: string) => boolean): boolean {
        return this.lines.some(predicate);
    }
}

/**
 * Everything scoped to one test run against one environment: active bots, the
 * message/console-log buffers matchers poll, and the console channel. Replaces
 * the module-level singletons that made it impossible to run two environments
 * in one process.
 *
 * `testRegistry`/`scopeStack` (test-registry.ts) stay module-level with a
 * per-file reset — correct only as long as one process runs one environment
 * and files run sequentially. Don't reach for this class to parallelize spec
 * files without revisiting that too.
 */
export class Session {
    readonly env: Environment;
    console: ServerConsole | null = null;
    readonly bots: Bot[] = [];
    readonly consoleLog = new MessageBuffer();

    /** Set once by the runner after loading plugins. Fired by `PlayerWrapper.join()` on
     *  every connection (initial join and every `rejoin()`), not called directly by
     *  `Session` itself. */
    onPlayerCreate: ((player: PlayerWrapper, ctx: { account: Account; env: Environment }) => Promise<void> | void) | null = null;

    constructor(env: Environment) {
        this.env = env;
    }

    /** Pulls the console channel from the environment. Called once `env.setup()` has produced one. */
    refreshConsole(): void {
        this.console = this.env.console();
    }

    createBot(options: BotConnectionOptions & { username: string }): Bot {
        const bot = mineflayer.createBot({
            host: options.host,
            port: options.port,
            username: options.username,
            version: options.version,
            auth: options.auth,
            // mineflayer's own default (logErrors: true) does `bot.on('error', e =>
            // console.log(e))` unconditionally — fine for an occasional bad packet, but a
            // server sending something outside the client's protocol data (e.g. a particle
            // type minecraft-data doesn't recognise for this version) can emit that error
            // hundreds of times a second. Full exceptions logged synchronously at that rate
            // starve the event loop and the piped stdout, so timers that would otherwise
            // fail the test fast stop firing in any useful time. Handled below instead, with
            // logging throttled so the connection survives being spammed by a packet type it
            // can't decode.
            logErrors: false,
            ...(options.profilesFolder ? { profilesFolder: options.profilesFolder } : {}),
        });

        this.bots.push(bot);

        let errorCount = 0;
        let lastLoggedAt = 0;
        bot.on('error', (err: Error) => {
            errorCount++;
            const now = Date.now();
            if (now - lastLoggedAt > 1000) {
                console.log(pc.dim(`[Bot] ${options.username} error (${errorCount} so far): ${err.message}`));
                lastLoggedAt = now;
            }
        });

        bot.once('end', (reason: string) => {
            console.log(pc.dim(`[Bot] ${options.username} connection ended: ${reason}`));
        });

        return bot;
    }

    removeBot(bot: Bot): void {
        const idx = this.bots.indexOf(bot);
        if (idx !== -1) this.bots.splice(idx, 1);
    }

    /**
     * Disconnects a bot, waiting for the `end` event or a timeout.
     * Skips the wait entirely if the client is already ended.
     *
     * Every exit path removes the bot's listeners: a disconnected client isn't reused, so
     * nothing should still be reacting to its events (mineflayer keeps the client object
     * alive briefly after `end`, and a stale listener firing during that window is how a
     * message meant for a torn-down player used to reach the wrong place).
     */
    disconnectBot(bot: Bot, label: string, timeoutMs: number = 3000): Promise<void> {
        const cleanupListeners = () => {
            try {
                bot.removeAllListeners();
            } catch (err) {
                console.log(pc.dim(`[Bot] ${label} warning: failed to remove listeners: ${(err as Error).message}`));
            }
        };

        const isAlreadyEnded = !!(bot as any)._client?.ended;
        if (isAlreadyEnded) {
            cleanupListeners();
            return Promise.resolve();
        }

        return new Promise<void>((resolve) => {
            const timeout = setTimeout(() => {
                console.log(pc.dim(`[Bot] ${label} disconnect timeout, continuing`));
                cleanupListeners();
                resolve();
            }, timeoutMs);

            try {
                bot.once('end', () => {
                    clearTimeout(timeout);
                    cleanupListeners();
                    resolve();
                });
                bot.quit();
            } catch (err) {
                console.log(pc.dim(`[Bot] ${label} error during disconnect: ${(err as Error).message}`));
                clearTimeout(timeout);
                cleanupListeners();
                resolve();
            }
        });
    }

    /** Disconnects every bot except those in `keep`. Called with no argument, this is a full
     *  teardown, which is what the end of a test does.
     *
     *  Each bot goes through `disconnectBot`, which is also what strips its listeners: a kept
     *  bot is still connected and still listening, so tearing the others down must not be a
     *  second implementation that forgets to.
     *
     *  Snapshots which bots to disconnect before the `await`, then removes exactly those from
     *  `this.bots` afterward — not "whatever isn't in `keep`" recomputed after the fact. A
     *  concurrent caller can push a new bot onto `this.bots` while this call is awaiting; that
     *  bot is in neither snapshot, so it survives here untouched instead of being silently
     *  dropped from tracking without ever being disconnected. */
    async disconnectAllBots(keep: Bot[] = []): Promise<void> {
        const keepSet = new Set(keep);
        const toDisconnect = this.bots.filter(b => !keepSet.has(b));

        await Promise.all(
            toDisconnect.map((b, i) => this.disconnectBot(b, b.username ?? `bot-${i}`, 2000))
        );

        const disconnectedSet = new Set(toDisconnect);
        for (let i = this.bots.length - 1; i >= 0; i--) {
            if (disconnectedSet.has(this.bots[i])) this.bots.splice(i, 1);
        }
    }

    private _remainder = '';

    /** Feeds raw environment output (e.g. Minecraft server stdout/stderr) into the console log buffer. */
    writeConsoleOutput(data: Buffer): void {
        const text = (this._remainder + data.toString()).replace(/\r\n/g, '\n');
        const lines = text.split('\n');
        this._remainder = lines.pop() || '';
        for (const line of lines) {
            if (line.length > 0) {
                this.consoleLog.push(line);
            }
        }
        const prefixed = lines
            .map(line => line.length > 0 ? `${pc.gray('[MC]')} ${line}\n` : '\n')
            .join('');
        if (prefixed.length > 0) {
            process.stdout.write(prefixed);
        }
    }
}
