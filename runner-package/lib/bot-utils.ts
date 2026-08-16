import mineflayer, { Bot } from 'mineflayer';
import pc from 'picocolors';

/** Shared mutable state for active bots and buffers. */
export const activeBots: Bot[] = [];
export const serverConsoleBuffer: string[] = [];

/**
 * Disconnects a bot, waiting for the `end` event or a timeout.
 * Cleans up all listeners BEFORE registering end handler so it isn't stripped.
 * Skips the wait entirely if the client is already ended.
 */
export function disconnectBot(bot: Bot, label: string, timeoutMs: number = 3000): Promise<void> {
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

/**
 * Creates a new mineflayer bot and registers it in the activeBots list.
 */
export function createBot(options: {
    host: string;
    port: number;
    username: string;
    version: string | undefined;
    auth: 'mojang' | 'microsoft' | 'offline';
}): Bot {
    const bot = mineflayer.createBot({
        host: options.host,
        port: options.port,
        username: options.username,
        version: options.version,
        auth: options.auth,
    });

    activeBots.push(bot);

    bot.once('end', (reason: string) => {
        console.log(pc.dim(`[Bot] ${options.username} connection ended: ${reason}`));
    });

    return bot;
}

/**
 * Disconnects all active bots and clears the list.
 */
export async function disconnectAllBots(): Promise<void> {
    await Promise.all(
        activeBots.map((b, i) => disconnectBot(b, b.username ?? `bot-${i}`, 2000))
    );

    activeBots.length = 0;
}

/**
 * Writes Minecraft server output to the console and appends to the server console buffer.
 */
export function writeMcOutput(data: Buffer): void {
    const text = data.toString().replace(/\r\n/g, '\n');
    const lines = text.split('\n');
    for (const line of lines) {
        if (line.length > 0) {
            serverConsoleBuffer.push(line);
        }
    }
    const prefixed = lines
        .map(line => line.length > 0 ? `${pc.gray('[MC]')} ${line}` : '')
        .join('\n');
    process.stdout.write(prefixed);
}