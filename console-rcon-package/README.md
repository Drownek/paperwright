# @plugwright/console-rcon

RCON server console for [plugwright](https://github.com/Drownek/plugwright)'s `external` mode.

A local server gives plugwright a console for free: it owns the process, so it reads stdout and writes stdin. A server someone else started gives it nothing. RCON is how tests reach that server's console instead.

The Source RCON protocol is implemented directly over Node's `net` module, so this package has no dependencies of its own. Every command comes back with the server's answer, which means `executeAndWait` needs none of the client-side sync tricks a fire-and-forget channel does.

## Usage

Declared through the `external` environment's DSL rather than imported:

```kotlin
environments {
    create("staging", ExternalMode) {
        console {
            rcon {
                port.set(25575)
                password.set(secret.env("RCON_PASSWORD"))
            }
        }
    }
}
```

The server has to be listening. In `server.properties`:

```properties
enable-rcon=true
rcon.port=25575
rcon.password=…
```

`plugwrightCompileTests` installs this package once a build script declares an `rcon` block. If it is missing from `node_modules` anyway, the runner says which package to install and where, rather than printing a stack trace.

## What tests can do with it

Commands and their answers, which covers `server.execute(...)`, `player.makeOp()` and everything built on them. You can also use `session.console.executeAndWait(...)` which is specific to this package.

What it cannot do is show a test the rest of the server log. RCON reports `output: 'responses'`, so `expect(server).toHaveReceivedMessage(...)` fails fast with an explanation instead of timing out. Mark those tests `requires: ['consoleOutput:full']` and they skip on an RCON-only environment.

## License

MIT
