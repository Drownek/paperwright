# @plugwright/auth-authme

Reference [plugwright](https://github.com/Drownek/plugwright) authentication plugin for a
server running AuthMe (or anything else with the same login/register-by-chat flow).

On every bot connection — the initial join, a `player.rejoin()`, and the `external` mode's
admin-bot console — it waits for the login or register prompt and answers it:

- `account.justCreated` → `/register <password> <password>`
- otherwise → `/login <password>`

Microsoft (online-mode) accounts are left alone; AuthMe never prompts them.

## Usage

```kotlin
environments {
    create("gtamine", ExternalMode) {
        plugins {
            npm("@plugwright/auth-authme") {
                options["loginCommand"] = "/log"
            }
        }
    }
}
```

## Options

| Option | Default | Meaning |
|---|---|---|
| `loginCommand` | `/login` | Sent (with the password appended) for an existing account |
| `registerCommand` | `/register` | Sent (with the password twice) for a freshly generated account |
| `loginPromptPattern` | `log ?in\|password` | Regex matched against server messages to detect the login prompt |
| `registerPromptPattern` | `regist` | Regex matched against server messages to detect the register prompt |
| `successPattern` | `success\|welcome\|logged in\|authenticat` | Regex confirming the command worked |
| `timeoutMs` | `15000` | How long to wait for each prompt/confirmation |

A `preflight` test ships alongside the plugin and runs before any user spec: if the
login/register handshake above ever fails, the very first bot connection already throws, so
the preflight test mostly exists to put a clear, named failure at the top of the report
instead of a buried stack trace.

## License

MIT
