import type { ServerConsole } from '@drownek/plugwright';
import { RconConnection } from './lib/rcon-connection.js';

export interface RconConsoleConfig {
    host: string;
    port: number;
    password: string;
}

/**
 * `ServerConsole` over RCON: unlike `stdio` and `admin-bot`, the protocol gives a synchronous
 * response to every command, so `executeAndWait` doesn't need the `minecraft:say <syncId>`
 * round-trip trick those two rely on.
 */
export function rconConsole(config: RconConsoleConfig): ServerConsole {
    const connection = new RconConnection(config.host, config.port, config.password);

    return {
        kind: 'rcon',
        output: 'responses',

        async probe(): Promise<boolean> {
            try {
                await connection.ensureConnected();
                return true;
            } catch {
                return false;
            }
        },

        execute(cmd: string): void {
            connection.execute(cmd);
        },

        async executeAndWait(cmd: string, timeoutMs: number = 5000): Promise<string> {
            return connection.executeAndWait(cmd, timeoutMs);
        },
    };
}
