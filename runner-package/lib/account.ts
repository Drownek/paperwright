import { randomUUID } from 'node:crypto';
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
 * Stand-in used when an environment has no [AccountPool] of its own — a `local` bot is a
 * fresh offline-mode connection under a name the server has never seen.
 *
 * [password] is for the other case: a bot the test names itself. That bypasses the pool, so
 * nothing else knows a password for it, and the test has to bring one for the authentication
 * plugin to use.
 */
export function syntheticAccount(username: string, password?: string): Account {
    return { username, password, auth: 'offline', justCreated: true };
}

/** A short random identity suffix. Four hex digits: long enough that two names in a run
 *  colliding is not a realistic worry, short enough to leave room under Minecraft's 16-character
 *  username limit for whatever prefix the pattern puts in front of it. */
export function randomSuffix(): string {
    return randomUUID().slice(0, 4);
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

/** True for a pattern that asks for a random suffix (`pw_%s`) rather than a sequence number
 *  (`pw_%04d`). The difference is what the pool does with a name once a test is done with it —
 *  see [AccountPool.release]. */
function isUniquePattern(pattern: string): boolean {
    return pattern.includes('%s');
}

/** Formats an auto-register username. `%s` becomes a random suffix, `%d` (optionally
 *  zero-padded, `%04d`) the sequence number. No other printf feature is supported. */
function formatUsername(pattern: string, n: number): string {
    return pattern
        .replace(/%s/, randomSuffix())
        .replace(/%(\d*)d/, (_match, width: string) => {
            const digits = String(n);
            return width ? digits.padStart(parseInt(width, 10), '0') : digits;
        });
}

/**
 * Leasable accounts for `external`, merged from three sources: a fixed `pool`, generated
 * `autoRegister` names, and `microsoft` accounts for an online-mode server. Accounts are leased
 * per test and returned in `finally` — see `test-runner.ts`.
 *
 * `autoRegister` has two shapes, told apart by the pattern. A numbered one (`pw_%04d`) is a
 * fixed set of slots: a name comes back to the pool when the test that held it is done, and the
 * next test gets that same account, already registered. A `%s` pattern generates a name per
 * lease and never hands it out again, so a test starts on an account the server has never seen —
 * at the price of a registration the server keeps.
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
    private readonly autoRegister: { usernamePattern: string; password: SecretRef; max: number; unique: boolean } | null;
    /** Names handed out by a `%s` pattern and still checked out. Kept so [release] can tell a
     *  one-shot identity from a numbered slot without a flag on [Account] itself. */
    private readonly uniqueOut = new Set<string>();
    /** Every declared `pool`/`microsoft` name, free or not — so a request for one by name can
     *  say whether it is taken or was never configured at all. */
    private readonly declaredNames = new Set<string>();

    constructor(config: AccountsConfig | null | undefined) {
        for (const entry of config?.pool ?? []) {
            this.declaredNames.add(entry.username);
            this.queue.push({ username: entry.username, secret: entry.password, auth: 'offline', justCreated: false });
        }
        for (const username of config?.microsoft?.accounts ?? []) {
            this.declaredNames.add(username);
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
                unique: isUniquePattern(config.autoRegister.usernamePattern),
            }
            : null;
    }

    /** Total slots that can be checked out at once: pool + microsoft + `autoRegister`'s max.
     *  Not the number currently free. */
    capacity(): number {
        return this.queue.length + (this.autoRegister?.max ?? 0);
    }

    /** Leases the next free account, or the one named by [username] — a `describe.serial` block
     *  that has to run as one specific account. A name that is taken, or was never declared,
     *  throws: quietly substituting another account is how a test ends up asserting against
     *  state that belongs to somebody else. */
    async lease(username?: string): Promise<Account> {
        if (username !== undefined) return this.leaseNamed(username);

        const entry = this.queue.shift();
        if (entry) {
            const { secret, ...account } = entry;
            return secret && account.password === undefined
                ? { ...account, password: resolveSecret(secret) }
                : account;
        }

        // For a numbered pattern `autoRegisterIssued` counts names that exist; for a `%s`
        // pattern it counts names currently checked out, since released ones are never
        // handed back. Either way `max` is the number of bots that can be connected at once.
        if (this.autoRegister && this.autoRegisterIssued < this.autoRegister.max) {
            this.autoRegisterIssued++;
            const username = formatUsername(this.autoRegister.usernamePattern, this.autoRegisterIssued);
            if (this.autoRegister.unique) this.uniqueOut.add(username);
            return { username, password: resolveSecret(this.autoRegister.password), auth: 'offline', justCreated: true };
        }

        throw new Error(
            'AccountPool exhausted: no pool/microsoft account is free and accounts.autoRegister has reached its max'
        );
    }

    private leaseNamed(username: string): Account {
        const idx = this.queue.findIndex(e => e.username === username);
        if (idx === -1) {
            throw new Error(this.declaredNames.has(username)
                ? `Account "${username}" is already leased by another test`
                : `Account "${username}" is not in this environment's accounts pool`);
        }
        const { secret, ...account } = this.queue.splice(idx, 1)[0];
        return secret && account.password === undefined
            ? { ...account, password: resolveSecret(secret) }
            : account;
    }

    /** Returns a leased account, `finally`-style. A numbered `autoRegister` account comes back
     *  with `justCreated: false` — the server registered it on its first lease, so the auth
     *  plugin logs in on every lease after. A `%s` account is dropped instead: its name is spent,
     *  and what comes back is only the slot it occupied. */
    release(account: Account): void {
        if (this.uniqueOut.delete(account.username)) {
            this.autoRegisterIssued--;
            return;
        }
        this.queue.push(account.justCreated ? { ...account, justCreated: false } : account);
    }
}
