import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { definePlugin, poll } from '@drownek/plugwright';

const __dirname = dirname(fileURLToPath(import.meta.url));

export interface AuthAuthmeOptions {
    /** Command sent for an existing account. */
    loginCommand?: string;
    /** Command sent for a freshly generated account (`account.justCreated`); receives the
     *  password twice, matching AuthMe's own `/register <pass> <pass>`. */
    registerCommand?: string;
    /** Regex (source only, case-insensitive) matched against server messages to detect the
     *  login prompt. */
    loginPromptPattern?: string;
    /** Regex matched against server messages to detect the register prompt. */
    registerPromptPattern?: string;
    /** Regex matched against server messages to confirm the command was accepted. */
    successPattern?: string;
    /** Regex matched against server messages to confirm the player is now authenticated.
     *  Narrower than [successPattern]: a registration is acknowledged before the login that
     *  follows it, and commands sent in between are still rejected. Deliberately excludes
     *  "success" and "welcome" — both fire on AuthMe's own "Successfully registered!" line,
     *  which would otherwise pass for the login that hasn't happened yet. Also avoids a bare
     *  "login" alternative: this pattern also gates the redundant-login fallback below, and a
     *  bare "login" would match AuthMe's login prompt ("Please, login with the command:
     *  /login <password>") too, turning a failed retry into a false "authenticated". */
    authenticatedPattern?: string;
    /** How long to wait for each prompt/confirmation before giving up. */
    timeoutMs?: number;
    /** Password used for accounts that carry none of their own — the throwaway identities an
     *  environment without an account pool generates per bot. Plugin options travel as plain
     *  values, so only use this where the password is worth nothing: a local, disposable
     *  server. Anywhere else, put the accounts in the pool and let the password be a secret. */
    password?: string;
}

const DEFAULTS: Required<Omit<AuthAuthmeOptions, 'password'>> = {
    loginCommand: '/login',
    registerCommand: '/register',
    loginPromptPattern: 'log ?in|password',
    registerPromptPattern: 'regist',
    successPattern: 'success|welcome|logged in|authenticat',
    authenticatedPattern: 'success(ful)? login|logged in|authenticat',
    timeoutMs: 15000,
};

// `onPlayerCreate` doesn't receive the plugin's options — only `setup()` does — so the
// resolved settings live here, captured once when the session starts. Safe because a runner
// process only ever runs one session at a time (see Session's own module-level caveats).
let resolved: Required<Omit<AuthAuthmeOptions, 'password'>> & { password?: string } = DEFAULTS;

/**
 * Reference authentication plugin for a server running AuthMe (or anything with the same
 * login/register-by-chat flow). `onPlayerCreate` fires on every bot connection — the initial
 * join and every `player.rejoin()` — and on the `external` mode's admin-bot console too, since
 * that connects through the exact same `PlayerWrapper.join()` path a test bot does.
 */
export default definePlugin<AuthAuthmeOptions>({
    name: 'authme',
    apiVersion: 1,
    tests: [{ file: join(__dirname, 'auth.spec.js'), mode: 'preflight' }],

    setup({ options }) {
        resolved = { ...DEFAULTS, ...options };
    },

    async onPlayerCreate(player, { account }) {
        // Online-mode (Microsoft) accounts never see AuthMe's offline-mode login wall.
        if (account.auth === 'microsoft') return;

        const password = account.password ?? resolved.password;
        if (!password) {
            throw new Error(
                `authme: account "${account.username}" has no password to log in with. ` +
                'Give the environment an accounts pool, or set the plugin\'s "password" option ' +
                'for a throwaway local server.'
            );
        }

        const registerPrompt = new RegExp(resolved.registerPromptPattern, 'i');
        const loginPrompt = new RegExp(resolved.loginPromptPattern, 'i');
        const successPattern = new RegExp(resolved.successPattern, 'i');

        // Which of the two the server asks for is the server's decision, not ours:
        // `account.justCreated` is a hint from the account pool, and it is wrong whenever a
        // pool account outlives the run that created it. So wait for either prompt and answer
        // the one that actually arrived. Register is tested first because AuthMe's register
        // prompt names the password too, and would otherwise match the login pattern.
        const joinIndex = player.getMessageBufferIndex();
        const since = (index: number, pattern: RegExp): string | undefined =>
            player.messageBuffer.slice(index).find((m: string) => pattern.test(m));

        const isRegistration = await poll(
            () => {
                if (since(joinIndex, registerPrompt)) return true;
                if (since(joinIndex, loginPrompt)) return false;
                return undefined;
            },
            {
                timeout: resolved.timeoutMs,
                message: `authme: never saw a login or register prompt for "${account.username}"`,
            },
        );

        // Everything below only looks at messages newer than the command. A server's greeting
        // often carries a word like "welcome", which would otherwise pass for confirmation
        // and let the test start before the player is actually authenticated.
        const commandIndex = player.getMessageBufferIndex();
        player.chat(isRegistration
            ? `${resolved.registerCommand} ${password} ${password}`
            : `${resolved.loginCommand} ${password}`);

        await poll(() => since(commandIndex, successPattern), {
            timeout: resolved.timeoutMs,
            message: `authme: "${account.username}" did not confirm ${isRegistration ? 'registration' : 'login'} in time`,
        });

        if (!isRegistration) return;

        // A registration is confirmed before the login it triggers, and a command sent in
        // between is rejected as unauthenticated. AuthMe normally logs the player in itself;
        // with forceLoginAfterRegister it does not, and the login has to be sent by hand.
        const authenticated = new RegExp(resolved.authenticatedPattern, 'i');
        const autoLoggedIn = await poll(() => since(commandIndex, authenticated), { timeout: 3000 })
            .catch(() => null);
        if (autoLoggedIn) return;

        const loginIndex = player.getMessageBufferIndex();
        player.chat(`${resolved.loginCommand} ${password}`);
        await poll(() => since(loginIndex, authenticated), {
            timeout: resolved.timeoutMs,
            message: `authme: "${account.username}" registered but never logged in`,
        });
    },
});
