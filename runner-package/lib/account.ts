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
}

/**
 * Stand-in used until a proper `AccountPool` (a later phase) exists. `local` bots are
 * always fresh, unauthenticated offline-mode connections, so this is accurate today — it
 * just isn't pluggable to other sources yet.
 */
export function syntheticAccount(username: string): Account {
    return { username, auth: 'offline', justCreated: true };
}
