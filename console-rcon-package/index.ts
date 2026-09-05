import type { ServerConsole } from '@plugwright/runner';
import { RconConnection } from './lib/rcon-connection.js';

export interface RconConsoleConfig {
    host: string;
    port: number;
    password: string;
}

export interface RconConsole extends ServerConsole {
    executeAndWait(cmd: string, timeoutMs?: number): Promise<string>;
}

/**
 * `ServerConsole` over RCON: unlike `stdio`, the protocol gives a synchronous
 * response to every command, so `executeAndWait` doesn't need the `minecraft:say <syncId>`
 * round-trip trick.
 */
export function rconConsole(config: RconConsoleConfig): RconConsole {
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
