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

    async resolve(options: ReuseOptions, connect: () => Promise<ConnectedPlayer>): Promise<ResolveResult> {
        if (options.key) {
            const existing = this.entries.find(e => e.key === options.key);
            if (existing) {
                if (matches(existing, options)) return this.checkout(existing, connect);
                await this.drop(existing, `abilities don't match a new request for key "${options.key}"`);
            }
            return this.createEntry(options.key, connect);
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

        return this.createEntry(derivedKey(options), connect);
    }

    /** Returns a checked-out entry to the free pool. No-op for a player this registry doesn't own. */
    release(player: PlayerWrapper): void {
        const entry = this.entries.find(e => e.player === player);
        if (!entry) return;
        entry.checkedOut = false;
        entry.lastUsedAt = Date.now();
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

    /** A dead connection is transparently rejoined before it's handed out — a bot picked back
     *  up by the registry is otherwise indistinguishable from one that's still live, and the
     *  test has no reason to expect it might not be. A failed rejoin falls back to a fresh
     *  entry under the same key, same as a first-time miss. */
    private async checkout(entry: RegistryEntry, connect: () => Promise<ConnectedPlayer>): Promise<ResolveResult> {
        if ((entry.player.bot as any)._client?.ended) {
            try {
                await entry.player.rejoin();
            } catch (error) {
                await this.drop(entry, `dead connection, rejoin failed: ${(error as Error).message}`);
                return this.createEntry(entry.key, connect);
            }
        }

        entry.checkedOut = true;
        const labels = [...entry.player.abilities].join(', ') || '-';
        console.log(pc.dim(`[Reuse] ${entry.player.username} from registry (key "${entry.key}", abilities: ${labels})`));
        return { player: entry.player, key: entry.key, reused: true };
    }

    private async createEntry(key: string, connect: () => Promise<ConnectedPlayer>): Promise<ResolveResult> {
        const { player, account, pool } = await connect();
        this.entries.push({ key, player, account, pool, checkedOut: true, lastUsedAt: Date.now() });
        console.log(pc.dim(`[Reuse] ${player.username} new player (key "${key}")`));
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
