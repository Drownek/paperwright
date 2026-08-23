import { resolveSecret } from './config.js';
import type { SecretRef } from './config.js';

/**
 * A bot's login identity as seen by an environment and its auth plugin. `justCreated` is
 * the key field for authentication plugins: a fresh account needs to register, an existing
 * one needs to log in.
 */
export interface Account {
    username: string;
    password?: string;
    auth: 'offline' | 'microsoft';
    justCreated: boolean;
    /** Set for `microsoft` accounts: where mineflayer should cache the device-code token. */
    microsoftCacheDir?: string;
}

/**
 * Stand-in used when an environment has no [AccountPool] of its own — `local` bots are
 * always fresh, unauthenticated offline-mode connections, so this stays exactly what it
 * always was.
 */
export function syntheticAccount(username: string): Account {
    return { username, auth: 'offline', justCreated: true };
}

/** An account as it sits in the pool: an [Account] whose password may still be a reference to
 *  a secret rather than the secret itself. Once leased, the resolved password stays on the
 *  entry, so a second lease of the same account doesn't re-read the environment. */
type PooledEntry = Account & { secret?: SecretRef };

export interface AccountsConfig {
    pool?: Array<{ username: string; password: SecretRef }>;
    autoRegister?: { usernamePattern: string; password: SecretRef; max: number } | null;
    microsoft?: { accounts: string[]; cacheDir?: string | null } | null;
}

/** Formats an auto-register username from a `pw_%04d`-style pattern. Only zero-padded
 *  decimal substitution is supported — no other printf feature. */
function formatUsername(pattern: string, n: number): string {
    return pattern.replace(/%(\d*)d/, (_match, width: string) => {
        const digits = String(n);
        return width ? digits.padStart(parseInt(width, 10), '0') : digits;
    });
}

/**
 * Leasable accounts for `external`, merged from three sources: a fixed `pool`, generated
 * `autoRegister` names (fresh on first lease, reusable after), and `microsoft` accounts for
 * an online-mode server. Accounts are leased per test and returned in `finally` — see
 * `test-runner.ts`.
 *
 * Exhausted when every pool/microsoft slot is checked out and `autoRegister` (if any) has
 * reached its `max`: `lease()` then throws rather than silently handing out an identity two
 * concurrently-connected bots would fight over.
 */
export class AccountPool {
    /** Queue entries keep the secret *reference*: a run that never connects a bot — a
     *  cleanup pass, a console-only ping — must not demand that the passwords be set. They
     *  are resolved in [lease], where an unset variable is a real problem. */
    private readonly queue: PooledEntry[] = [];
    private autoRegisterIssued = 0;
    private readonly autoRegister: { usernamePattern: string; password: SecretRef; max: number } | null;

    constructor(config: AccountsConfig | null | undefined) {
        for (const entry of config?.pool ?? []) {
            this.queue.push({ username: entry.username, secret: entry.password, auth: 'offline', justCreated: false });
        }
        for (const username of config?.microsoft?.accounts ?? []) {
            this.queue.push({
                username,
                auth: 'microsoft',
                justCreated: false,
                microsoftCacheDir: config?.microsoft?.cacheDir ?? undefined,
            });
        }
        this.autoRegister = config?.autoRegister
            ? {
                usernamePattern: config.autoRegister.usernamePattern,
                password: config.autoRegister.password,
                max: config.autoRegister.max,
            }
            : null;
    }

    async lease(): Promise<Account> {
        const entry = this.queue.shift();
        if (entry) {
            const { secret, ...account } = entry;
            return secret && account.password === undefined
                ? { ...account, password: resolveSecret(secret) }
                : account;
        }

        if (this.autoRegister && this.autoRegisterIssued < this.autoRegister.max) {
            this.autoRegisterIssued++;
            const username = formatUsername(this.autoRegister.usernamePattern, this.autoRegisterIssued);
            return { username, password: resolveSecret(this.autoRegister.password), auth: 'offline', justCreated: true };
        }

        throw new Error(
            'AccountPool exhausted: no pool/microsoft account is free and accounts.autoRegister has reached its max'
        );
    }

    /** Returns a leased account to the pool, `finally`-style. An `autoRegister`-created
     *  account comes back with `justCreated: false` — the server already registered it on
     *  its first lease, so the auth plugin logs in on every lease after. */
    release(account: Account): void {
        this.queue.push(account.justCreated ? { ...account, justCreated: false } : account);
    }
}
