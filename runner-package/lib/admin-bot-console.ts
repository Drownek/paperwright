import type { ServerConsole } from './console.js';
import type { Session } from './session.js';
import type { BotConnectionOptions } from './environment.js';
import type { Account } from './account.js';
import { PlayerWrapper } from './player.js';
import { sleep } from './utils.js';

/**
 * A second mineflayer bot with staff rights, used as a console channel when nothing lower-
 * level (RCON) is available. Commands go out through chat; responses are read back from this
 * bot's own `PlayerWrapper.messageBuffer` — already isolated per bot, so console traffic
 * naturally never mixes with a test player's chat log without this class keeping a second
 * copy of the same lines.
 *
 * Connects lazily, on the first `probe()`: that's also where authentication happens, through
 * the exact same `PlayerWrapper.join()` → `session.onPlayerCreate` path a test bot goes
 * through, so a plugin's login flow applies here unmodified.
 */
export class AdminBotConsole implements ServerConsole {
    readonly kind = 'admin-bot' as const;
    readonly output = 'responses' as const;

    private player: PlayerWrapper | null = null;

    constructor(
        private readonly session: Session,
        private readonly connOpts: BotConnectionOptions,
        private readonly identity: { username: string; password?: string },
    ) {}

    async probe(): Promise<boolean> {
        if (this.player) return true;
        try {
            const bot = this.session.createBot({ ...this.connOpts, username: this.identity.username });

            const player = new PlayerWrapper(bot, this.session);
            player._captureSpawnPromise();
            player._setBotOptions(this.connOpts);
            const account: Account = {
                username: this.identity.username,
                password: this.identity.password,
                auth: this.connOpts.auth === 'microsoft' ? 'microsoft' : 'offline',
                justCreated: false,
            };
            player._setAccount(account);

            await player.join();
            this.player = player;
            return true;
        } catch (error) {
            console.warn(`[console] admin-bot probe failed: ${(error as Error).message}`);
            return false;
        }
    }

    execute(cmd: string): void {
        if (!this.player) throw new Error('admin-bot console is not connected');
        this.player.chat(toChatCommand(cmd));
    }

    async executeAndWait(cmd: string, timeoutMs: number = 5000): Promise<string> {
        if (!this.player) throw new Error('admin-bot console is not connected');
        const buffer = this.player.messageBuffer;
        const since = buffer.length;
        this.execute(cmd);

        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
            const lines = buffer.slice(since);
            if (lines.length > 0) return lines.join('\n');
            await sleep(50);
        }
        throw new Error(`admin-bot console command timed out: ${cmd}`);
    }
}

/** stdio-style console commands use `minecraft:<cmd>`; a chat-based console needs a leading
 *  slash instead. */
function toChatCommand(cmd: string): string {
    const stripped = cmd.startsWith('minecraft:') ? cmd.slice('minecraft:'.length) : cmd;
    return stripped.startsWith('/') ? stripped : `/${stripped}`;
}
