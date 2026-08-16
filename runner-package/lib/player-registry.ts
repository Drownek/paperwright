import pc from 'picocolors';
import type { Bot } from 'mineflayer';
import type { PlayerWrapper } from './player.js';
import type { Account, AccountPool } from './account.js';
import type { Session } from './session.js';

/** What a test asks for when it wants a long-lived player instead of a fresh connection.
 *  `key` names an identity directly; without it, matching goes by ability labels. */
export interface ReuseOptions {
    /** Explicit identity. Needed when a test cares that it gets the *same* bot back —
     *  the second player in a multiplayer test, for instance. */
    key?: string;
    /** Labels the player must carry. */
    abilities?: string[];
    /** Labels the player must not carry. */
    excludeAbilities?: string[];
    /** The player's label set must equal `abilities` exactly — no extras allowed. */
    strict?: boolean;
    /** Whether the bot keeps its connection once the test that borrowed it finishes. `false`
     *  parks the entry instead: the account, the nick and the labels survive, the connection
     *  doesn't, and a later test that takes the entry gets a `rejoin()` first. That's the shape
     *  a server which kicks an idle bot needs. Defaults to the run's `tests.reuse.stay`. */
    stay?: boolean;
}

export interface ConnectedPlayer {
    player: PlayerWrapper;
    account: Account;
    pool: AccountPool | null;
}

export interface ResolveResult {
    player: PlayerWrapper;
    key: string;
    reused: boolean;
}

interface RegistryEntry {
    key: string;
    player: PlayerWrapper;
    account: Account;
    pool: AccountPool | null;
    /** Held by the current test: not handed out a second time, not evicted by LRU. */
    checkedOut: boolean;
    /** Released with `stay: false`, so the bot left the server but the entry stayed. Checking
     *  it out again rejoins first. */
    parked: boolean;
    lastUsedAt: number;
}

/** Implicit key for a request with no explicit `key`: the normalized requirement set, so two
 *  requests asking for the same shape of player land on the same entry. */
function derivedKey(options: ReuseOptions): string {
    const abilities = [...(options.abilities ?? [])].sort().join(',');
    const exclude = [...(options.excludeAbilities ?? [])].sort().join(',');
    return `auto:[${abilities}]!(${exclude})${options.strict ? ':strict' : ''}`;
}

function matches(entry: RegistryEntry, options: ReuseOptions): boolean {
    const abilities = entry.player.abilities;
    if ((options.abilities ?? []).some(a => !abilities.has(a))) return false;
    if ((options.excludeAbilities ?? []).some(a => abilities.has(a))) return false;
    if (options.strict && abilities.size !== (options.abilities?.length ?? 0)) return false;
    return true;
}

/**
 * Long-lived bots that survive test boundaries within one run. Entries are matched by the
 * ability labels a player carries (see `PlayerWrapper.abilities`) rather than by resetting
 * server state back to a known baseline — the core has no way to undo what a plugin's own
 * commands changed, so it doesn't pretend to.
 *
 * `resolve()` never connects a bot itself; it calls the `connect` callback it's given, so the
 * caller keeps ownership of connection options, throttling and account leasing.
 *
 * An entry surviving a test boundary does not have to stay *connected* across it: released with
 * `stay: false`, it parks — the bot leaves, the identity (account, nick, labels) stays, and the
 * next test to take the entry gets a rejoin. What's reused there is the identity, not the
 * connection, which is the only form of reuse a server that kicks idle bots allows.
 */
export class PlayerRegistry {
    private readonly entries: RegistryEntry[] = [];

    constructor(
        private readonly session: Session,
        private readonly maxPlayers: number,
    ) {}

    /** Every bot this registry currently owns — checked out by the running test or sitting
     *  free for the next one. Callers pass this to `Session.disconnectAllBots` as the "keep"
     *  list, so a per-test sweep doesn't take down an entry no test happened to touch this
     *  time. */
    ownedBots(): Bot[] {
        return this.entries.map(e => e.player.bot);
    }

    /** `onFreshEntry` fires exactly when this call ends up creating a brand-new entry —
     *  first-ever request for a key, or a rebuild after a drop — never on a plain checkout of
     *  an entry that's already live. A rejected `onFreshEntry` discards the entry it just built,
     *  same as a broken connection would, and the rejection propagates to the caller. */
    async resolve(
        options: ReuseOptions,
        connect: () => Promise<ConnectedPlayer>,
        onFreshEntry?: (key: string, player: PlayerWrapper) => Promise<void>,
    ): Promise<ResolveResult> {
        if (options.key) {
            const existing = this.entries.find(e => e.key === options.key);
            if (existing) {
                if (matches(existing, options)) return this.checkout(existing, connect);
                await this.drop(existing, `abilities don't match a new request for key "${options.key}"`);
            }
            return this.createEntry(options.key, connect, onFreshEntry);
        }

        const free = this.entries.find(e => !e.checkedOut && matches(e, options));
        if (free) return this.checkout(free, connect);

        if (this.entries.length >= this.maxPlayers) {
            const victim = this.entries
                .filter(e => !e.checkedOut)
                .sort((a, b) => a.lastUsedAt - b.lastUsedAt)[0];
            if (!victim) {
                throw new Error(
                    `PlayerRegistry: maxPlayers=${this.maxPlayers} reached and every entry is checked out ` +
                    'by the current test. Request fewer simultaneous players, or raise tests.reuse.maxPlayers.'
                );
            }
            await this.drop(victim, `evicted: maxPlayers=${this.maxPlayers} reached`);
        }

        return this.createEntry(derivedKey(options), connect, onFreshEntry);
    }

    /** Returns a checked-out entry to the free pool. `stay: false` parks it on the way out —
     *  the connection goes, the entry stays, and the next checkout rejoins it. No-op for a
     *  player this registry doesn't own. */
    async release(player: PlayerWrapper, stay: boolean = true): Promise<void> {
        const entry = this.entries.find(e => e.player === player);
        if (!entry) return;
        entry.checkedOut = false;
        entry.lastUsedAt = Date.now();

        if (stay || entry.parked) return;
        entry.parked = true;
        console.log(pc.dim(`[Reuse] ${entry.player.username} parked (stay: false — rejoins when a later test takes it)`));
        await this.session.disconnectBot(entry.player.bot, entry.player.username);
        this.session.removeBot(entry.player.bot);
    }

    /** Drops a broken or disqualified entry: disconnects it, returns its account, forgets it.
     *  No-op for a player this registry doesn't own. */
    async invalidate(player: PlayerWrapper, reason: string = 'invalidated'): Promise<void> {
        const entry = this.entries.find(e => e.player === player);
        if (entry) await this.drop(entry, reason);
    }

    /** Disconnects and forgets every entry — end-of-run teardown. */
    async disconnectAll(): Promise<void> {
        for (const entry of [...this.entries]) await this.drop(entry, 'session teardown');
    }

    /** An entry that isn't connected — parked on purpose, or dropped by the server — is
     *  transparently rejoined before it's handed out: a bot picked back up by the registry is
     *  otherwise indistinguishable from one that's still live, and the test has no reason to
     *  expect it might not be. A failed rejoin falls back to a fresh entry under the same key,
     *  same as a first-time miss. */
    private async checkout(entry: RegistryEntry, connect: () => Promise<ConnectedPlayer>): Promise<ResolveResult> {
        const parked = entry.parked;
        if (parked || (entry.player.bot as any)._client?.ended) {
            try {
                // The same gate a first connection passes through: a rejoin is just another
                // login as far as a shared server's join throttle is concerned, and `stay: false`
                // turns every single test into one.
                await this.session.env.beforeJoin?.();
                await entry.player.rejoin();
            } catch (error) {
                await this.drop(entry, `${parked ? 'parked' : 'dead connection'}, rejoin failed: ${(error as Error).message}`);
                return this.createEntry(entry.key, connect);
            }
            entry.parked = false;
        }

        entry.checkedOut = true;
        const labels = [...entry.player.abilities].join(', ') || '-';
        const how = parked ? 'from registry, rejoined' : 'from registry';
        console.log(pc.dim(`[Reuse] ${entry.player.username} ${how} (key "${entry.key}", abilities: ${labels})`));
        return { player: entry.player, key: entry.key, reused: true };
    }

    private async createEntry(
        key: string,
        connect: () => Promise<ConnectedPlayer>,
        onFreshEntry?: (key: string, player: PlayerWrapper) => Promise<void>,
    ): Promise<ResolveResult> {
        const { player, account, pool } = await connect();
        const entry: RegistryEntry = { key, player, account, pool, checkedOut: true, parked: false, lastUsedAt: Date.now() };
        this.entries.push(entry);
        console.log(pc.dim(`[Reuse] ${player.username} new player (key "${key}")`));

        if (onFreshEntry) {
            try {
                await onFreshEntry(key, player);
            } catch (error) {
                await this.drop(entry, `reuseTest failed: ${(error as Error).message}`);
                throw error;
            }
        }

        return { player, key, reused: false };
    }

    private async drop(entry: RegistryEntry, reason: string): Promise<void> {
        const idx = this.entries.indexOf(entry);
        if (idx !== -1) this.entries.splice(idx, 1);
        console.log(pc.dim(`[Reuse] ${entry.player.username} discarded (${reason})`));
        await this.session.disconnectBot(entry.player.bot, entry.player.username);
        this.session.removeBot(entry.player.bot);
        entry.pool?.release(entry.account);
    }
}
