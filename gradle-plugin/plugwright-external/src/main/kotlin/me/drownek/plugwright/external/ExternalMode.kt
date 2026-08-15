package me.drownek.plugwright.external

import me.drownek.plugwright.api.ConfigNodeBuilder
import me.drownek.plugwright.api.PlugwrightMode
import me.drownek.plugwright.api.RunnerPackageRef
import me.drownek.plugwright.api.TaskRegistrationContext
import me.drownek.plugwright.api.ValidationContext
import org.gradle.api.model.ObjectFactory

/**
 * Built-in mode: attaches bots to a server that's already running somewhere, instead of
 * spawning and owning one. No provisioning step, no deploy of the jar under test — the
 * counterpart of everything [me.drownek.plugwright.local.LocalMode] does for a local Paper.
 */
object ExternalMode : PlugwrightMode<ExternalEnvironmentSpec> {
    override val id = "external"
    override val specType = ExternalEnvironmentSpec::class.java

    override fun createSpec(name: String, objects: ObjectFactory): ExternalEnvironmentSpec =
        ExternalEnvironmentSpec(name, objects)

    override fun runnerPackages(spec: ExternalEnvironmentSpec): List<RunnerPackageRef> = buildList {
        add(RunnerPackageRef("@drownek/plugwright", export = "externalEnvironment"))
        val needsRcon = spec.consoleSpec?.channels?.any { it is ConsoleChannelSpec.Rcon } == true
        if (needsRcon) {
            add(RunnerPackageRef("@plugwright/console-rcon", "^1.0.0", export = "rconConsole"))
        }
    }

    override fun validate(spec: ExternalEnvironmentSpec, ctx: ValidationContext) {
        if (!spec.host.isPresent || spec.host.get().isBlank()) {
            ctx.error("host must be set")
        }
        if (!spec.minecraftVersion.isPresent || spec.minecraftVersion.get().isBlank()) {
            ctx.error("minecraftVersion must be set (a proxy in front of the stand defeats automatic protocol detection)")
        }

        spec.accountsSpec.autoRegister?.let { autoRegister ->
            val pattern = autoRegister.usernamePattern.getOrElse("")
            if (!pattern.startsWith("pw_")) {
                ctx.error("accounts.autoRegister.usernamePattern must start with \"pw_\" (got \"$pattern\") — generated accounts must be recognizable as test accounts")
            }
            if (autoRegister.max.getOrElse(0) <= 0) {
                ctx.error("accounts.autoRegister.max must be positive")
            }
        }

        for (channel in spec.consoleSpec?.channels ?: emptyList()) {
            when (channel) {
                is ConsoleChannelSpec.Rcon ->
                    if (!channel.password.isPresent) ctx.error("console.rcon.password must be set")
                is ConsoleChannelSpec.AdminBot ->
                    if (!channel.password.isPresent) ctx.error("console.adminBot(\"${channel.username}\").password must be set")
            }
        }
    }

    override fun serialize(spec: ExternalEnvironmentSpec, node: ConfigNodeBuilder) {
        node.put("host", spec.host.get())
        node.put("port", spec.port.get())
        node.put("minecraftVersion", spec.minecraftVersion.get())
        node.put("joinThrottleMs", spec.joinThrottleMs.get())

        node.array("console") {
            (spec.consoleSpec?.channels ?: emptyList()).forEach { channel ->
                obj {
                    when (channel) {
                        is ConsoleChannelSpec.Rcon -> {
                            put("kind", "rcon")
                            put("port", channel.port.get())
                            put("password", channel.password.get())
                        }
                        is ConsoleChannelSpec.AdminBot -> {
                            put("kind", "adminBot")
                            put("username", channel.username)
                            put("password", channel.password.get())
                        }
                    }
                }
            }
        }

        node.obj("accounts") {
            array("pool") {
                (spec.accountsSpec.pool?.accounts ?: emptyList()).forEach { account ->
                    obj {
                        put("username", account.username)
                        put("password", account.password.get())
                    }
                }
            }
            val autoRegister = spec.accountsSpec.autoRegister
            if (autoRegister != null) {
                obj("autoRegister") {
                    put("usernamePattern", autoRegister.usernamePattern.get())
                    put("password", autoRegister.password.get())
                    put("max", autoRegister.max.get())
                }
            } else {
                putNull("autoRegister")
            }
            val microsoft = spec.accountsSpec.microsoft
            if (microsoft != null) {
                obj("microsoft") {
                    putStrings("accounts", microsoft.accountNames)
                    if (microsoft.cacheDir.isPresent) {
                        put("cacheDir", microsoft.cacheDir.get().asFile.absolutePath)
                    }
                }
            } else {
                putNull("microsoft")
            }
        }
    }

    override fun registerTasks(spec: ExternalEnvironmentSpec, ctx: TaskRegistrationContext) {
        val project = ctx.project
        val envName = spec.name

        ctx.pluginConfigs(project.provider { spec.pluginsSpec.entries.toList() })
        val configProvider = project.provider { ConfigNodeBuilder().also { serialize(spec, it) }.build() }
        val journalFile = project.layout.buildDirectory.file("plugwright/$envName-journal.jsonl")

        ctx.register("Ping", PlugwrightPingTask::class.java) {
            environmentName.set(envName)
            modeId.set(id)
            testsDir.set(ctx.testsDir)
            configFile.set(project.layout.buildDirectory.file("tmp/plugwright/$envName-ping.json"))
            environmentConfig.set(configProvider)
        }

        ctx.register("Clean", PlugwrightCleanupTask::class.java) {
            environmentName.set(envName)
            modeId.set(id)
            testsDir.set(ctx.testsDir)
            configFile.set(project.layout.buildDirectory.file("tmp/plugwright/$envName-cleanup.json"))
            environmentConfig.set(configProvider)
            this.journalFile.set(journalFile)
        }

        // No prepareTask: unlike local, external doesn't provision anything before
        // plugwrightTest<Env> — the stand is assumed to already be up.
    }
}
