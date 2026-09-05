# @plugwright/auth-authme

Reference [plugwright](https://github.com/Drownek/plugwright) authentication plugin for a server running AuthMe, or anything else that asks for a password in chat.

On every bot connection — the first bot of a test, a second bot from `createPlayer()`, and every `player.rejoin()` — it waits for the server's prompt and answers it. Registration is followed through to the login it triggers, because a command sent between the two is still rejected as unauthenticated.

Microsoft (online-mode) accounts go through the same handshake by default — whether AuthMe still puts up a login wall for a premium account is a server-side setting, not something this plugin assumes. Set `skipOnMicrosoftAccount` if you've confirmed yours doesn't.

## Usage

```kotlin
environments {
    create("staging", ExternalMode) {
        accounts {
            autoRegister {
                usernamePattern.set("pw_%04d")
                password.set(secret.env("BOT_PASSWORD"))
                max.set(4)
            }
        }
        plugins {
            npm("@plugwright/auth-authme") {
                options["loginCommand"] = "/log"
            }
        }
    }
}
```

The same block works on a `LocalMode` environment. A local server running AuthMe puts up the same wall as a remote one.

## Which command it sends

The server decides, not the account. `account.justCreated` is a hint from the account pool, and it is wrong every time a pool account outlives the run that created it — that is the second run against any stand. So the plugin waits for whichever of a register prompt, a login prompt, or a session-resume message arrives, and acts on that. The register pattern is tested first, since AuthMe's register prompt mentions the password too and would otherwise look like a login prompt.

A reconnect within AuthMe's own session timeout gets no prompt at all — AuthMe already considers the account logged in and says so via `sessionResumedPattern` instead. The plugin stops there without sending a command. Nothing matching within `timeoutMs` is treated as a genuine failure, not a stale session.

## Options

| Option | Default | Meaning |
|---|---|---|
| `loginCommand` | `/login` | Sent with the password appended |
| `registerCommand` | `/register` | Sent with the password twice |
| `loginPromptPattern` | `log ?in\|password` | Regex identifying the login prompt |
| `registerPromptPattern` | `regist` | Regex identifying the register prompt |
| `successPattern` | `success\|welcome\|logged in\|authenticat` | Regex confirming the command was accepted |
| `authenticatedPattern` | `logged in\|authenticat` | Narrower regex confirming the player is actually authenticated |
| `sessionResumedPattern` | `Session Reconnection` | Regex confirming AuthMe resumed the session on its own, no prompt needed |
| `timeoutMs` | `15000` | How long to wait for each prompt or confirmation |
| `password` | — | Fallback password for accounts that carry none |
| `skipOnMicrosoftAccount` | `false` | Skip the handshake entirely for `microsoft` accounts |

All patterns are matched case-insensitively, and only against messages that arrived after the step they belong to. A greeting containing the word "welcome" would otherwise pass for a login confirmation, and the test would start before the player could run a single command.

`password` covers accounts an environment invents rather than leases: `LocalMode` hands every test a throwaway `Test_<uuid>` with no password of its own. Plugin options travel as plain strings, so use it only where the password protects nothing — a local server that is deleted after the run. Anywhere else, put the accounts in `accounts { }`, where the password stays a secret reference until the runner reads it.

`microsoft` accounts (`accounts { microsoft { ... } }`) carry no password of their own either — mineflayer authenticates them itself — so if your server still prompts them, they need `password` too. Set `skipOnMicrosoftAccount = true` only once you've confirmed your server lets premium accounts straight through without one.

## Preflight test

A `preflight` test ships with the plugin and runs before any user spec. The handshake above already throws on the first connection if it fails, so the test mostly exists to put a named failure at the top of the report instead of a stack trace buried in someone else's test.

## Server-side settings that matter

A stock AuthMe config is tuned for humans and rejects a test suite in three specific ways. On a disposable local server:

```yaml
settings:
    registration:
        dialog:
            preJoin: { enable: false }    # bots cannot answer a dialog
            postJoin: { enable: false }
    restrictions:
        maxRegPerIp: 0                    # every test registers from 127.0.0.1
Protection:
    enableAntiBot: false                  # a test suite looks exactly like a bot attack
```

The `example_plugin` in this repository writes that file through `writeFiles { }` and runs its full suite against it.

## License

MIT
