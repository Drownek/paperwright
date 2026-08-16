# example_plugin

A small Bukkit plugin and the E2E suite that tests it. Everything here runs against the plugwright build in this repository through `includeBuild("../gradle-plugin")`, so changes to the plugin or the runner show up without publishing anything.

The same 47 tests run against two environments, declared in `build.gradle.kts`.

## `local` — plugwright owns the server

```bash
./gradlew plugwrightTest
```

Downloads Paper into `src/test/e2e/generated/local/run`, installs PlaceholderAPI and AuthMe next to the plugin under test, writes an AuthMe config a bot can get through, starts the server, runs everything, and shuts it down. Every test gets a fresh username, which AuthMe treats as a fresh registration, which `@plugwright/auth-authme` answers.

## `stand` — someone else owns the server

This one connects to a server that is already running and leaves it running. Provision it once, start it by hand, then point the tests at it.

```bash
# 1. Prepare the run directory (Paper, plugins, server.properties with RCON enabled)
./gradlew plugwrightProvisionLocal

# 2. Start the server yourself, from where the local environment put it
cd src/test/e2e/generated/local/run && ./start.sh
```

`generated/` is not in version control, so `start.sh` is yours to write. Anything that starts the jar with Java 21 will do:

```sh
#!/usr/bin/env sh
set -e
cd "$(dirname "$0")"
JAVA_BIN="${JAVA_BIN:-java}"
JVM_ARGS="${JVM_ARGS:--Xmx2G}"
exec "$JAVA_BIN" $JVM_ARGS -Dcom.mojang.eula.agree=true -jar server.jar --nogui
```

`start.sh` is listed in the `local` environment's `cleanExcludePatterns`, so provisioning again won't delete it.

```bash
# 3. In another terminal
export PLUGWRIGHT_BOT_PASSWORD=plugwright
export PLUGWRIGHT_RCON_PASSWORD=plugwright

./gradlew plugwrightPingStand    # connects, probes RCON, logs one bot in
./gradlew plugwrightTestStand
```

Expect skips. The stand leases four accounts from a pool instead of inventing a name per test, so anything that assumes a clean balance, an unclaimed kit or an empty arena is excluded, and anything that reads the whole server log is skipped — RCON answers commands, it doesn't stream the log.

`plugins/stand-reset.ts` handles what can be reset: it deops the leased account and clears its inventory before each test. It is loaded for the `stand` environment only, through `plugins { local("stand-reset") }`.

## Layout

```
src/main/java/…/ExamplePlugin.java       the plugin under test
src/test/e2e/tests/*.spec.ts             the suite, run against both environments
src/test/e2e/plugins/stand-reset.ts      a runner plugin, stand only
src/test/e2e/dist/                       compiled specs and plugins
src/test/e2e/generated/local/run/        the Paper server the local environment owns
build.gradle.kts                         both environment declarations
```
