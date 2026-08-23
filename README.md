# Plugwright

[![Gradle Plugin Portal](https://img.shields.io/gradle-plugin-portal/v/io.github.drownek.plugwright?label=Gradle%20Plugin%20Portal)](https://plugins.gradle.org/plugin/io.github.drownek.plugwright)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)
[![CI](https://github.com/Drownek/plugwright/actions/workflows/ci.yml/badge.svg)](https://github.com/Drownek/plugwright/actions/workflows/ci.yml)
[![Read The Docs](https://img.shields.io/badge/Docs-Read_Here-007EC6?logo=readthedocs&logoColor=white)](https://plugwright.dev)

End-to-end testing framework for Paper/Spigot Minecraft plugins. Supports JavaScript and TypeScript.

![Video showcase demonstrating Plugwright bots joining a server, moving, and interacting with GUIs](https://github.com/user-attachments/assets/0272a6d9-f9ab-4486-8bf3-ee5909a10ee9)

<details>
<summary>⚠️ <strong>Upgrading from Paperwright (v1.x)? Click here for migration steps.</strong></summary>
<br>
This framework has been renamed from Paperwright to Plugwright. If you are upgrading from an older version, update the following:

1. Change `id("io.github.drownek.paperwright")` to `id("io.github.drownek.plugwright")`.
2. Rename your `paperwright { ... }` configuration block to `plugwright { ... }` and Gradle tasks (e.g. `./gradlew paperwrightTest` to `./gradlew plugwrightTest`).
3. In your `package.json`, change `@drownek/paperwright` to `@plugwright/runner` and run `npm install`.
4. Update your test files: `import { test } from '@drownek/paperwright'` to `import { test } from '@plugwright/runner'`.
5. Change your CI to use `drownek/plugwright-action@v1`.
</details>

<details>
<summary>⚠️ <strong>Upgrading from Plugwright 2.x? The npm package moved.</strong></summary>
<br>
The runner is published as <code>@plugwright/runner</code> from 3.0 onwards; <code>@drownek/plugwright</code> stops receiving releases at 2.x. Change the dependency in your <code>package.json</code>, run <code>npm install</code>, and update the import in your test files. Nothing else moves: the Gradle plugin id stays <code>io.github.drownek.plugwright</code>.
</details>

## Features

`🚀` **Setup** – Automated server lifecycle management with Paper server downloads.
  * **Supported Minecraft versions:** 1.8 to 1.21.11 (1.8, 1.9, 1.10, 1.11, 1.12, 1.13, 1.14, 1.15, 1.16, 1.17, 1.18, 1.19, 1.20, 1.21, 1.21.9, 1.21.11)

`🎮` **Bot Testing** – Powered by Mineflayer. Bots join, move, chat, and click GUIs like real players.

`🎭` **Playwright-inspired API** – Live handles and locators for scripting player interactions.

`🧪` **Type-Safe** – Native JavaScript and TypeScript with full type safety.

`🔄` **Automatic Retries** – Built-in retry logic to handle flaky tests.

`📊` **Rich Assertions** – Custom matchers built for Minecraft mechanics.

`🔧` **Gradle Integration** – Run your entire suite with a single command.

## Quick Start

**0. Prerequisites:**
Before you begin, you need:
- **Java 17** or higher
- **Gradle 7** or higher
- **Node.js** (for running the test runner, can be downloaded automatically by using downloadNode setting)
- **A Paper/Spigot plugin project**

**1. Add the plugin to your `build.gradle.kts`:**

```kotlin
plugins {
    id("io.github.drownek.plugwright") version "2.0.3"
}

plugwright {
    minecraftVersion.set("1.19.4")
    testsDir.set(file("src/test/e2e"))
    acceptEula.set(true)
    
    // Download some dependencies your plugin might need
    downloadPlugins {
        url("https://url.to/plugin1.jar")
        url("https://url.to/plugin2.jar")
        // ... etc
    }

    // If true, always downloads and uses an isolated Node.js version, ignoring the system Node.
    downloadNode.set(true)
}
```

> **💡 Tip:** If you already have Node.js installed on your system, you can comment out `downloadNode.set(true)` to speed up initialization. Otherwise, leave it uncommented.

**2. Initialize the test folder:**

Run the init command to set up your test folder. It asks where to put it, then writes an npm project with a `package.json`, a TypeScript config, a `.gitignore`, an example spec and an example runner plugin:

```bash
./gradlew plugwrightInit
```

```
src/test/e2e/
  tests/example.spec.ts          your specs go here
  plugins/example-plugin.ts      hooks, fixtures and matchers
  package.json, tsconfig.json
  .gitignore                     node_modules, dist, generated
```

Compiled specs land in `dist`, and everything an environment writes — the Paper server the local one starts, for instance — in `generated`. Neither belongs in version control. See [Project Layout](https://plugwright.dev/project-layout).

**3. Run your tests:**

```bash
./gradlew plugwrightTest
```

> **💡 Tip:** Plugwright hooks into your build process and tests against your compiled plugin jar. Ensure your plugin compiles successfully (e.g. `jar` or `shadowJar` task) before running tests!

> **💡 Want to see a working example?** Check out the [example_plugin](./example_plugin) directory in this repository.

## Testing against more than one server

The block above describes a single local Paper server, which is all most projects need. When you also want to run the same suite against a staging server someone else keeps running, name the servers explicitly:

```kotlin
import me.drownek.plugwright.api.secret
import me.drownek.plugwright.external.ExternalMode
import me.drownek.plugwright.local.LocalMode

plugwright {
    testsDir.set(file("src/test/e2e"))

    environments {
        create("local", LocalMode) {
            minecraftVersion.set("1.21.11")
            acceptEula.set(true)
        }

        create("staging", ExternalMode) {
            host.set("mc.example.com")
            minecraftVersion.set("1.20.4")

            console { rcon { port.set(25575); password.set(secret.env("RCON_PASSWORD")) } }
            accounts {
                autoRegister {
                    usernamePattern.set("pw_%04d")
                    password.set(secret.env("BOT_PASSWORD"))
                    max.set(4)
                }
            }
            plugins { npm("@plugwright/auth-authme") }
        }
    }
}
```

`./gradlew plugwrightTest` runs the matrix and prints a summary per environment; `./gradlew plugwrightTestStaging` runs one. A server behind a login wall needs a runner plugin to get past it, and `@plugwright/auth-authme` is the reference implementation for AuthMe-style login. Writing your own kind of environment — a proxy, a Compose stack — is a Kotlin mode plus an npm package.

- [Project layout](https://plugwright.dev/project-layout) — where specs, plugins and generated files live
- [Environments](https://plugwright.dev/environments) — modes, tasks, the matrix
- [External servers](https://plugwright.dev/external-servers) — console channels, account pools, cleanup
- [Runner plugins](https://plugwright.dev/plugins) — hooks, fixtures, matchers, inherited tests
- [Writing a mode](https://plugwright.dev/custom-modes)

## Why Plugwright vs MockBukkit?

|                          | **Plugwright**                                              | **MockBukkit**                                                             |
|--------------------------|-------------------------------------------------------------|----------------------------------------------------------------------------|
| **Approach**             | End-to-end – runs a real Paper server with real player bots | Unit testing – mocks the Bukkit API in-process                             |
| **Server**               | Real Paper server with actual game logic                    | No server – simulated API stubs                                            |
| **Player interaction**   | Real Mineflayer bots that join, move, chat, and click GUIs  | Mocked `Player` objects with simulated method calls                        |
| **NMS / internals**      | ✅ Full support – real server means real NMS                 | ❌ Breaks on NMS / reflection / internals                                   |
| **Plugin compatibility** | Tests the plugin exactly as players experience it           | May miss bugs caused by mock/real behavior mismatch                        |
| **Multi-plugin testing** | ✅ All plugins load together naturally                       | Limited – each mock is isolated                                            |
| **GUI testing**          | ✅ First-class support with locators and click simulation    | Partial – inventory content mocks supported; click/drag simulation limited |
| **Speed**                | Slower (server startup ~10-20s, then fast)                  | Very fast (milliseconds per test)                                          |
| **Best for**             | Integration & E2E tests, NMS-heavy plugins, GUI testing     | Fast unit tests for pure Bukkit API logic                                  |

> **💡 Tip:** Plugwright and MockBukkit work well together. MockBukkit for fast unit tests; Plugwright for end-to-end tests that verify behavior on a real server.

## Continuous Integration (CI)

Setting up CI takes less than 5 minutes. Use the official [plugwright-action](https://github.com/Drownek/plugwright-action) to run your entire test suite on every pull request.

```yaml
name: E2E Tests
on: [push, pull_request]

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: drownek/plugwright-action@v1
```

## Publishing

Releasing Plugwright itself is two commands — `npm run publish:packages` for the npm
packages and `./gradlew publishToPublicRepository` for the gradle plugin. Both go to their
public homes, npmjs.com and the Gradle Plugin Portal, and tagging a commit `v*` runs them
for you.

The same two commands publish to a registry of your own instead, for an organisation whose
builds cannot reach the public ones. The URL and its credentials come from the environment
rather than from any file in the repository — see [`.env.example`](.env.example) and the
[publishing guide](https://plugwright.dev/publishing).

## Documentation & Examples

For full examples on how to test **GUIs**, **multi-bot interactions**, **NMS**, and the complete **API Reference**, visit our official documentation site:

> 👉 **[Read the full documentation at plugwright.dev](https://plugwright.dev)**

## Support & Community

Got a question, found a bug, or want to suggest a feature? 
👉 **[Open an issue](https://github.com/Drownek/plugwright/issues)** - don't hesitate, even if it's just a beginner question!

## License

MIT
