import me.drownek.plugwright.api.secret
import me.drownek.plugwright.external.ExternalMode
import me.drownek.plugwright.local.LocalMode

plugins {
    `java-library`
    id("de.eldoria.plugin-yml.bukkit") version "0.8.0"
    id("com.gradleup.shadow") version "9.0.0"
    id("io.github.drownek.plugwright") version "3.0.0-dev.0"
}

// Password every bot on the local server registers with. It guards a server that lives for
// the length of one test run, so it is a literal here; on a real stand the password belongs
// in an account pool, where it stays a secret reference until the runner reads it.
val localBotPassword = "plugwright"

// RCON password shared by the server the "stand" environment connects to and by the console
// channel that connects back to it. The literal is the fallback for a server started without
// the variable set; the console channel reads the variable itself, at run time.
val standRconPassword: String = providers.environmentVariable("PLUGWRIGHT_RCON_PASSWORD").getOrElse("plugwright")

plugwright {
    testsDir.set(file("src/test/e2e"))
    downloadNode.set(System.getenv("CI") != "true")
    primaryEnvironment.set("local")

    environments {
        // Paper downloaded, patched, started and killed by plugwright itself.
        create("local", LocalMode) {
            minecraftVersion.set("1.21.11")
            acceptEula.set(true)
            runDir.set(file("run"))

            // start.sh is the hand-written launcher the "stand" environment connects to; it
            // lives in the run directory and has to survive the clean that precedes each run.
            cleanExcludePatterns.set(listOf("server.jar", "cache", "libraries", "start.sh"))

            downloadPlugins {
                url("https://hangarcdn.papermc.io/plugins/HelpChat/PlaceholderAPI/versions/2.11.6/PAPER/PlaceholderAPI-2.11.6.jar")
                url("https://github.com/AuthMe/AuthMeReloaded/releases/download/6.0.0/AuthMe-6.0.0-Paper.jar")
            }

            // Two things the stock AuthMe config does that no bot can answer: it asks for the
            // password through Paper's dialog UI, and it allows one registration per IP, while
            // a fresh bot name per test means a fresh registration per test from 127.0.0.1.
            writeFiles {
                // RCON is off in a stock server.properties. The local environment talks to the
                // server through its own stdout and never needs it; the "stand" environment,
                // which owns no process, has no other way to reach the console.
                file("server.properties", """
                    enable-rcon=true
                    rcon.port=25575
                    rcon.password=$standRconPassword
                """.trimIndent())

                file("plugins/AuthMe/config.yml", """
                    settings:
                        sessions:
                            enabled: false
                        registration:
                            dialog:
                                preJoin:
                                    enable: false
                                postJoin:
                                    enable: false
                        restrictions:
                            maxRegPerIp: 0
                            maxJoinPerIp: 0
                            maxLoginPerIp: 0
                            timeout: 60
                            allowedNicknameCharacters: '[a-zA-Z0-9_]*'
                        security:
                            minPasswordLength: 5
                    Protection:
                        # A test suite is a stream of short-lived logins from one address,
                        # which is exactly what AuthMe's antibot heuristic exists to stop.
                        enableAntiBot: false
                        quickCommands:
                            # A test sends its first command the moment it is logged in, which
                            # the stock one-second grace period treats as bot behavior.
                            denyCommandsBeforeMilliseconds: 0
                """.trimIndent())
            }

            plugins {
                npm("@plugwright/auth-authme") {
                    options["password"] = localBotPassword
                }
            }
        }

        // The same tests against a server plugwright does not own: started by hand from
        // ./run, still up when the tests connect, still up after they finish. Out of the
        // default matrix because it needs that server to be running.
        create("stand", ExternalMode) {
            host.set("localhost")
            port.set(25565)
            minecraftVersion.set("1.21.11")
            includeInMatrix.set(false)
            joinThrottleMs.set(500)

            // The stand's own console, over the port the local environment enabled in
            // server.properties. Without it there is no way to op a bot or read server output.
            console {
                rcon {
                    port.set(25575)
                    password.set(secret.env("PLUGWRIGHT_RCON_PASSWORD"))
                }
            }

            // Four accounts, leased per test and returned afterwards. They outlive the run,
            // so from the second run on they log in instead of registering.
            accounts {
                autoRegister {
                    usernamePattern.set("pw_%04d")
                    password.set(secret.env("PLUGWRIGHT_BOT_PASSWORD"))
                    max.set(4)
                }
            }

            plugins {
                npm("@plugwright/auth-authme")
                // Compiled output of src/test/e2e/plugins/stand-reset.ts.
                local(file("src/test/e2e/dist/plugins/stand-reset.js"))
            }

            // Matched against test names. What is left out here is what the stand cannot give
            // back: a balance, a kit or an arena slot that is spent once and stays spent. Op
            // and inventory are reset per test by the stand-reset plugin instead. multi-bot is
            // out for a different reason — it names its second bot, and a named bot is not a
            // pool account, so nothing knows its password.
            excludeTests.set(listOf(
                "balance", "send money", "kit", "arena", "shop", "buy", "first join", "multi-bot"
            ))
        }
    }
}

group = "me.drownek"
version = "1.0-SNAPSHOT"

bukkit {
    main = "me.drownek.example.ExamplePlugin"
    apiVersion = "1.13"
    name = "ExamplePlugin"
    author = "Drownek"

    commands {
        register("example") {
            description = "Example command for plugwright testing"
        }
        register("warps") {
            description = "Warps paginated GUI"
        }
        register("admin") {
            description = "Admin command"
        }
        register("balance") {
            description = "Economy balance command"
        }
        register("pay") {
            description = "Economy pay command"
        }
        register("eco") {
            description = "Economy admin command"
        }
        register("shop") {
            description = "Shop command"
        }
        register("warp") {
            description = "Warp command"
        }
        register("kit") {
            description = "Kit command"
        }
        register("arena") {
            description = "Arena command"
        }
    }
}

repositories {
    mavenCentral()
    maven("https://repo.papermc.io/repository/maven-public/")
}

dependencies {
    compileOnly("org.spigotmc:spigot-api:1.19.4-R0.1-SNAPSHOT")

    /* lombok */
    compileOnly("org.projectlombok:lombok:1.18.40")
    annotationProcessor("org.projectlombok:lombok:1.18.40")
}

tasks.shadowJar {
    archiveFileName.set("bukkit-example-${project.version}.jar")
}

tasks.withType<JavaCompile> {
    options.compilerArgs.add("-parameters")
    options.encoding = "UTF-8"
}

java {
    toolchain {
        languageVersion.set(JavaLanguageVersion.of(21))
    }
}
