import pc from 'picocolors';
import type { Environment, EnvironmentCapabilities, BotConnectionOptions } from '../environment.js';
import type { ServerConsole } from '../console.js';
import type { Session } from '../session.js';
import type { SecretRef } from '../config.js';
import { resolveSecret } from '../config.js';
import { AccountPool } from '../account.js';
import type { AccountsConfig } from '../account.js';
import { sleep, importOptionalPackage } from '../utils.js';

export interface ExternalConsoleChannelConfig {
    kind: 'rcon';
    port?: number;
    username?: string;
    password?: SecretRef;
}

export interface ExternalEnvironmentConfig {
    host: string;
    port: number;
    minecraftVersion?: string | null;
    joinThrottleMs?: number | null;
    console?: ExternalConsoleChannelConfig[] | null;
    accounts?: AccountsConfig | null;
}

const BASE_CAPABILITIES: EnvironmentCapabilities = {
    console: false,
    consoleOutput: 'none',
    // Never assumed true: nothing here proves the leased accounts actually have op rights
    // on the stand. A mode that can prove it would override this after setup().
    op: false,
    freshState: false,
    arbitraryUsernames: true,
    lifecycle: false,
};

/**
 * Attaches bots to a server this mode does not own: no spawn, no patch, no shutdown. What it
 * does provide — a console channel (probed in declaration order), a merged account pool, and
 * join throttling — exists because a shared, already-running stand can't offer the guarantees
 * `local` gets for free from owning the whole process.
 */
class ExternalEnvironment implements Environment {
    readonly id = 'external';

    private readonly config: ExternalEnvironmentConfig;
    private readonly accountPool: AccountPool;
    private _capabilities: EnvironmentCapabilities = BASE_CAPABILITIES;
    private _console: ServerConsole | null = null;
    private lastJoinAt = 0;

    constructor(config: ExternalEnvironmentConfig) {
        this.config = config;
        this.accountPool = new AccountPool(config.accounts);
    }

    get capabilities(): EnvironmentCapabilities {
        return this._capabilities;
    }

    accounts(): AccountPool {
        return this.accountPool;
    }

    async setup(_session: Session): Promise<void> {
        for (const channel of this.config.console ?? []) {
            const candidate = await this.buildChannel(channel);
            if (!candidate) continue;
            try {
                if (await candidate.probe()) {
                    this._console = candidate;
                    break;
                }
                console.log(pc.yellow(`[external] console channel "${channel.kind}" did not respond to probe()`));
            } catch (error) {
                console.log(pc.yellow(`[external] console channel "${channel.kind}" failed to connect: ${(error as Error).message}`));
            }
        }

        this._capabilities = {
            ...BASE_CAPABILITIES,
            console: this._console !== null,
            consoleOutput: this._console?.output ?? 'none',
            // A reachable console is the ability to run `op`, which is what this capability
            // claims. Without one there is no way to grant it, hence the false in the base.
            op: this._console !== null,
        };

        console.log(this._console
            ? pc.green(`[external] console channel: ${this._console.kind} (output=${this._console.output})`)
            : pc.dim('[external] no console channel reachable, running without one'));
    }

    private async buildChannel(
        channel: ExternalConsoleChannelConfig,
    ): Promise<ServerConsole | null> {
        if (channel.kind === 'rcon') {
            // A bare string literal here would make tsc try to resolve
            // "@plugwright/console-rcon"'s types even though it's an optional peer package
            // this repo doesn't depend on — routing through a variable keeps the import
            // dynamic (untyped) without an ambient module declaration.
            const rconPackage = '@plugwright/console-rcon';
            let mod: any;
            try {
                mod = await importOptionalPackage(rconPackage);
            } catch (error) {
                console.error(pc.red(
                    'Mode "external": console { rcon { } } needs the "@plugwright/console-rcon" package.\n' +
                    'It installs automatically as part of plugwrightCompileTests — check that npm install\n' +
                    'completed in your tests directory and that the package appears under node_modules.\n' +
                    `(${(error as Error).message})`
                ));
                return null;
            }
            const factory = mod.rconConsole ?? mod.default;
            if (typeof factory !== 'function') {
                console.error(pc.red('"@plugwright/console-rcon" has no "rconConsole" export'));
                return null;
            }
            return factory({
                host: this.config.host,
                port: channel.port ?? 25575,
                password: channel.password ? resolveSecret(channel.password) : '',
            });
        }

        return null;
    }

    connection(): BotConnectionOptions {
        return {
            host: this.config.host,
            port: this.config.port,
            version: this.config.minecraftVersion ?? undefined,
            // Per-bot auth is decided by the leased Account, not here — test-runner.ts
            // overrides this default when the account is `microsoft`.
            auth: 'offline',
        };
    }

    console(): ServerConsole | null {
        return this._console;
    }

    async beforeJoin(): Promise<void> {
        const throttle = this.config.joinThrottleMs ?? 0;
        if (throttle <= 0) return;
        const wait = this.lastJoinAt + throttle - Date.now();
        if (wait > 0) await sleep(wait);
        this.lastJoinAt = Date.now();
    }

    async teardown(): Promise<void> {
        // No lifecycle: the tested server isn't ours to stop.
    }
}

export function externalEnvironment(config: ExternalEnvironmentConfig): Environment {
    return new ExternalEnvironment(config);
}
