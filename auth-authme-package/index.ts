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
    /** Regex matched against server messages to confirm login/registration succeeded. */
    successPattern?: string;
    /** How long to wait for each prompt/confirmation before giving up. */
    timeoutMs?: number;
}

const DEFAULTS: Required<AuthAuthmeOptions> = {
    loginCommand: '/login',
    registerCommand: '/register',
    loginPromptPattern: 'log ?in|password',
    registerPromptPattern: 'regist',
    successPattern: 'success|welcome|logged in|authenticat',
    timeoutMs: 15000,
};

// `onPlayerCreate` doesn't receive the plugin's options — only `setup()` does — so the
// resolved settings live here, captured once when the session starts. Safe because a runner
// process only ever runs one session at a time (see Session's own module-level caveats).
let resolved: Required<AuthAuthmeOptions> = DEFAULTS;

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

        const password = account.password;
        if (!password) {
            throw new Error(`authme: account "${account.username}" has no password to log in with`);
        }

        const command = account.justCreated
            ? `${resolved.registerCommand} ${password} ${password}`
            : `${resolved.loginCommand} ${password}`;
        const promptPattern = new RegExp(account.justCreated ? resolved.registerPromptPattern : resolved.loginPromptPattern, 'i');
        const successPattern = new RegExp(resolved.successPattern, 'i');

        await poll(() => player.session.messages.find((m) => promptPattern.test(m)), {
            timeout: resolved.timeoutMs,
            message: `authme: never saw the ${account.justCreated ? 'register' : 'login'} prompt for "${account.username}"`,
        });

        player.chat(command);

        await poll(() => player.session.messages.find((m) => successPattern.test(m)), {
            timeout: resolved.timeoutMs,
            message: `authme: "${account.username}" did not confirm ${account.justCreated ? 'registration' : 'login'} in time`,
        });
    },
});
