import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { definePlugin, poll } from '@plugwright/runner';

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
    /** Regex matched against server messages confirming AuthMe resumed an existing session on
     *  its own — no login/register needed. AuthMe sends this instead of a prompt when it
     *  considers the connecting player already authenticated (a reconnect within its session
     *  timeout). */
    sessionResumedPattern?: string;
    /** Password used for accounts that carry none of their own — the throwaway identities an
     *  environment without an account pool generates per bot. Plugin options travel as plain
     *  values, so only use this where the password is worth nothing: a local, disposable
     *  server. Anywhere else, put the accounts in the pool and let the password be a secret. */
    password?: string;
    /** Skip the login/register handshake entirely for `microsoft` (online-mode) accounts.
     *  Off by default: whether AuthMe still puts up its login wall for a premium account is a
     *  server-side setting (e.g. AuthMe's premium auto-login), not something this plugin can
     *  assume — see issue #65, where a `microsoft` account was prompted to `/register` like
     *  any other. Only set this once you've confirmed your server really does let Microsoft
     *  accounts straight through. Plugin options travel as strings from the Kotlin DSL, so set
     *  it as `options["skipOnMicrosoftAccount"] = "true"`. */
    skipOnMicrosoftAccount?: boolean;
}

const DEFAULTS: Required<Omit<AuthAuthmeOptions, 'password'>> = {
    loginCommand: '/login',
    registerCommand: '/register',
    loginPromptPattern: 'log ?in|password',
    registerPromptPattern: 'regist',
    successPattern: 'success|welcome|logged in|authenticat',
    authenticatedPattern: 'success(ful)? login|logged in|authenticat',
    timeoutMs: 15000,
    sessionResumedPattern: 'Session Reconnection',
    skipOnMicrosoftAccount: false,
};

// `onPlayerCreate` doesn't receive the plugin's options — only `setup()` does — so the
// resolved settings live here, captured once when the session starts. Safe because a runner
// process only ever runs one session at a time (see Session's own module-level caveats).
let resolved: Required<Omit<AuthAuthmeOptions, 'password'>> & { password?: string } = DEFAULTS;

// Kotlin's `options[k] = v` map is string-only (see PluginRefSpec), so a boolean option set
// through the Gradle DSL arrives here as the literal string "true"/"false", not a real
// boolean — a plain truthy check would treat "false" as on. Anything already boolean (options
// set from a JS/TS environment config directly) passes through unchanged.
const isEnabled = (value: boolean | string): boolean => value === true || value === 'true';

/**
 * Reference authentication plugin for a server running AuthMe (or anything with the same
 * login/register-by-chat flow). The credentials go straight into the runner's plugin configuration, and the runner manages
 * the authentication flow. It happens exactly once per bot — on the very first
 * join and every `player.rejoin()` — before test code ever gets a chance to see
 * the player.
 */
export default definePlugin<AuthAuthmeOptions>({
    name: 'authme',
    apiVersion: 1,
    tests: [{ file: join(__dirname, 'auth.spec.js'), mode: 'preflight' }],

    setup({ options }) {
        resolved = { ...DEFAULTS, ...options };
    },

    async onPlayerCreate(player, { account }) {
        // Opt-in only: whether AuthMe skips its login wall for a premium account depends on
        // server config, not on the account being `microsoft` (issue #65).
        if (account.auth === 'microsoft' && isEnabled(resolved.skipOnMicrosoftAccount)) return;

        const password = account.password ?? resolved.password;
        if (!password) {
            throw new Error(
                account.auth === 'microsoft'
                    ? `authme: microsoft account "${account.username}" has no password to log in with. ` +
                      'Microsoft accounts never carry one (mineflayer authenticates them itself), so set ' +
                      'the plugin\'s "password" option, or set "skipOnMicrosoftAccount" if your server ' +
                      'really doesn\'t put up a login wall for premium accounts.'
                    : `authme: account "${account.username}" has no password to log in with. ` +
                      'Give the environment an accounts pool, or set the plugin\'s "password" option ' +
                      'for a throwaway local server.'
            );
        }

        const registerPrompt = new RegExp(resolved.registerPromptPattern, 'i');
        const loginPrompt = new RegExp(resolved.loginPromptPattern, 'i');
        const sessionResumed = new RegExp(resolved.sessionResumedPattern, 'i');
        const successPattern = new RegExp(resolved.successPattern, 'i');

        // Which of the two the server asks for is the server's decision, not ours:
        // `account.justCreated` is a hint from the account pool, and it is wrong whenever a
        // pool account outlives the run that created it. So wait for whichever of the three
        // arrives and act on that. Register is tested first because AuthMe's register prompt
        // names the password too, and would otherwise match the login pattern.
        //
        // Hardcoded to 0 rather than `player.getMessageBufferIndex()`: the login prompt can
        // arrive during the handshake, before this handler even runs, so reading the buffer
        // index here can already be past it. Scanning from 0 risks matching a stale prompt from
        // a previous connection, but this buffer is fresh per player and the loss of precision
        // is worth never missing the real prompt.
        const joinIndex = 0;
        const since = (index: number, pattern: RegExp): string | undefined =>
            player.messageBuffer.slice(index).find((m: string) => pattern.test(m));

        // The server occasionally reconnects a player without prompting at all — AuthMe still
        // considers the account logged in from a connection that never fully closed, and says
        // so with `sessionResumedPattern` instead of a prompt. Trust that message and stop here:
        // no command to send, nothing left to confirm. Anything else within `timeoutMs` is a
        // genuine miss, not a stale session, and throws.
        const promptResult = await poll<'register' | 'login' | 'resumed'>(
            () => {
                if (since(joinIndex, registerPrompt)) return 'register';
                if (since(joinIndex, loginPrompt)) return 'login';
                if (since(joinIndex, sessionResumed)) return 'resumed';
                return undefined;
            },
            {
                timeout: resolved.timeoutMs,
                message: `authme: never saw a login/register prompt or session-resume message for "${account.username}"`,
            },
        );
        if (promptResult === 'resumed') {
            const authenticated = new RegExp(resolved.authenticatedPattern, 'i');
            await poll(() => since(joinIndex, authenticated), {
                timeout: resolved.timeoutMs,
                message: `authme: "${account.username}" session resumed, but never confirmed as authenticated`,
            });
            return;
        }
        const isRegistration = promptResult === 'register';

        // Everything below only looks at messages newer than the command. A server's greeting
        // often carries a word like "welcome", which would otherwise pass for confirmation
        // and let the test start before the player is actually authenticated.
        const commandIndex = player.getMessageBufferIndex();
        player.chat(isRegistration
            ? `${resolved.registerCommand} ${password} ${password}`
            : `${resolved.loginCommand} ${password}`, { secrets: [password] });

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
        player.chat(`${resolved.loginCommand} ${password}`, { secrets: [password] });
        await poll(() => since(loginIndex, authenticated), {
            timeout: resolved.timeoutMs,
            message: `authme: "${account.username}" registered but never logged in`,
        });
    },
});
