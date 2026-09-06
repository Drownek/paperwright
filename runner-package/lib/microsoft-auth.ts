import path from 'node:path';
import os from 'node:os';
import { Authflow, Titles } from 'prismarine-auth';

/** Same default `minecraft-protocol` itself falls back to (via the `minecraft-folder-path`
 *  package) when `profilesFolder` isn't set — kept in sync here since our custom `auth` function
 *  replaces its whole dispatch, defaults included. */
function defaultMinecraftFolder(): string {
    switch (os.type()) {
        case 'Darwin':
            return path.join(os.homedir(), 'Library', 'Application Support', 'minecraft');
        case 'Windows_NT':
            return path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), '.minecraft');
        default:
            return path.join(os.homedir(), '.minecraft');
    }
}

/** What we keep from a Microsoft account's login response across connections: everything
 *  `minecraft-protocol`'s own `microsoftAuth.authenticate` fetches but never caches itself. */
interface CachedProfile {
    profile: Record<string, any>;
    certificates: Record<string, any> | undefined;
}

/**
 * In-memory cache of `fetchProfile`/`fetchCertificates` results, keyed by Microsoft account
 * username, kept for the life of this process.
 *
 * Every test gets its own bot connection (`Session.createBot` → `mineflayer.createBot`), so a
 * `microsoft`-auth account redoes the full Microsoft handshake on every single test. The MS/Xbox
 * *token* is already disk-cached by `prismarine-auth` (`Authflow.getMinecraftJavaToken`'s own
 * `verifyTokens()` check) and stays cheap, but `fetchProfile`/`fetchCertificates` run
 * unconditionally on every connect with no caching of their own — enough tests in one run and one
 * of those calls eventually hits a rate limit, failing a test whose account is perfectly fine.
 * See issue #69.
 */
const cache = new Map<string, CachedProfile>();

/**
 * Builds a `minecraft-protocol` custom `auth` function for one Microsoft account, backed by
 * [cache]. Mirrors `minecraft-protocol`'s own `microsoftAuth.authenticate` (same defaults, same
 * session/error shape) but only fetches profile/certificates once per `username` per process —
 * every connection still gets a fresh access token, since that part is cheap already.
 */
export function microsoftAuthWithCache(username: string) {
    return async (client: any, options: any): Promise<void> => {
        if (!options.profilesFolder) options.profilesFolder = path.join(defaultMinecraftFolder(), 'nmp-cache');
        if (options.authTitle === undefined) {
            options.authTitle = Titles.MinecraftNintendoSwitch;
            options.deviceType = 'Nintendo';
            options.flow = 'live';
        }

        const authflow: Authflow = client.authflow ?? new Authflow(options.username, options.profilesFolder, options, options.onMsaCode);
        client.authflow = authflow;

        const cached = cache.get(username);
        const { token, profile, certificates } = await authflow.getMinecraftJavaToken({
            fetchProfile: !cached,
            fetchCertificates: !cached && !options.disableChatSigning,
        }).catch((err: Error) => {
            if (options.password) console.warn('Sign in failed, try removing the password field\n');
            if (err.toString().includes('Not Found')) console.warn(`Please verify that the account ${options.username} owns Minecraft\n`);
            throw err;
        });

        let entry = cached;
        if (!entry) {
            if (!profile || (profile as any).error) throw new Error(`Failed to obtain profile data for ${options.username}, does the account own minecraft?`);
            entry = { profile, certificates };
            cache.set(username, entry);
        }

        options.haveCredentials = token !== null;
        const session = {
            accessToken: token,
            selectedProfile: entry.profile,
            availableProfile: [entry.profile],
        };
        Object.assign(client, entry.certificates);
        client.session = session;
        client.username = entry.profile.name;
        options.accessToken = token;
        client.emit('session', session);
        options.connect(client);
    };
}
