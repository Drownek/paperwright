# @plugwright/console-rcon

RCON server console for [plugwright](https://github.com/Drownek/plugwright)'s `external` mode.

Implements the Source RCON protocol directly over Node's `net` module — no extra dependency.
Unlike the built-in `stdio` and `admin-bot` channels, RCON gives a synchronous response to
every command, so `executeAndWait` doesn't need any client-side sync trick.

## Usage

Declared through the `external` environment's DSL, not imported directly:

```kotlin
environments {
    create("gtamine", ExternalMode) {
        console {
            rcon {
                port.set(25575)
                password.set(secret.env("RCON_PASS"))
            }
        }
    }
}
```

`plugwrightCompileTests` installs this package automatically once a build script declares an
`rcon` block. If it's missing from `node_modules`, the runner prints a message telling you to
run `npm install` in your tests directory rather than a stack trace.

## License

MIT
