package me.drownek.plugwright.local

import me.drownek.plugwright.api.ConfigNode
import me.drownek.plugwright.api.ConfigNodeBuilder
import me.drownek.plugwright.api.LegacyEnvironmentProperties
import me.drownek.plugwright.api.PlugwrightMode
import me.drownek.plugwright.api.RunnerPackageRef
import me.drownek.plugwright.api.TaskRegistrationContext
import me.drownek.plugwright.api.ValidationContext
import org.gradle.api.model.ObjectFactory
import org.gradle.api.plugins.JavaPluginExtension
import org.gradle.api.provider.Provider
import org.gradle.jvm.toolchain.JavaLauncher
import org.gradle.jvm.toolchain.JavaToolchainService
import java.io.File

/**
 * Built-in mode: downloads Paper, patches its configs, spawns it, and points bots at
 * `localhost`. Registered by default wherever the `io.github.drownek.plugwright` id is
 * applied.
 */
object LocalMode : PlugwrightMode<LocalEnvironmentSpec> {
    override val id = "local"
    override val specType = LocalEnvironmentSpec::class.java

    override fun createSpec(name: String, objects: ObjectFactory): LocalEnvironmentSpec =
        LocalEnvironmentSpec(name, objects)

    override fun runnerPackages(spec: LocalEnvironmentSpec): List<RunnerPackageRef> =
        listOf(RunnerPackageRef("@drownek/plugwright", export = "localEnvironment"))

    override fun validate(spec: LocalEnvironmentSpec, ctx: ValidationContext) {
        if (spec.minecraftVersion.get().isBlank()) {
            ctx.error("minecraftVersion must not be blank")
        }
        if (!spec.runDir.isPresent) {
            ctx.error("runDir must be set")
        }
    }

    override fun applyLegacyDefaults(spec: LocalEnvironmentSpec, legacy: LegacyEnvironmentProperties) {
        spec.minecraftVersion.set(legacy.minecraftVersion)
        spec.jvmArgs.set(legacy.jvmArgs)
        spec.acceptEula.set(legacy.acceptEula)
        spec.runDir.set(legacy.runDir)
        spec.pluginUrls.set(legacy.pluginUrls)
        spec.runDirFiles.set(legacy.runDirFiles)
        spec.cleanExcludePatterns.set(legacy.cleanExcludePatterns)
        spec.useExternalPluginsOnly.set(legacy.useExternalPluginsOnly)
    }

    override fun serialize(spec: LocalEnvironmentSpec, node: ConfigNodeBuilder) {
        // Never actually reached: registerTasks() below always overrides this through
        // ctx.environmentConfig(...), since the real javaPath needs the toolchain service
        // that only a task (not this configuration-time call) can reach. Implemented anyway
        // so the fallback stays correct if that ever changes.
        fillConfig(node, spec, resolveJavaPath(null))
    }

    override fun registerTasks(spec: LocalEnvironmentSpec, ctx: TaskRegistrationContext) {
        val project = ctx.project

        val clean = ctx.register("Clean", PlugwrightCleanTask::class.java) {
            runDir.set(spec.runDir)
            cleanExcludePatterns.set(spec.cleanExcludePatterns)
        }

        val provision = ctx.register("Provision", PaperProvisionTask::class.java) {
            dependsOn(clean)
            runDir.set(spec.runDir)
            minecraftVersion.set(spec.minecraftVersion)
            pluginJar.set(ctx.projectPluginJar)
            pluginUrls.set(spec.pluginUrls)
            runDirFiles.set(spec.runDirFiles)
        }

        val javaLauncherProvider: Provider<JavaLauncher>? = run {
            val javaExtension = project.extensions.findByType(JavaPluginExtension::class.java)
            val toolchains = project.extensions.findByType(JavaToolchainService::class.java)
            if (javaExtension != null && toolchains != null) toolchains.launcherFor(javaExtension.toolchain) else null
        }

        ctx.register("RunServer", PlugwrightRunServerTask::class.java) {
            dependsOn(provision)
            runDir.set(spec.runDir)
            serverJarPath.set(spec.runDir.file("server.jar").map { it.asFile.absolutePath })
            jvmArgs.set(spec.jvmArgs)
            acceptEula.set(spec.acceptEula)
            javaLauncherProvider?.let { javaLauncher.set(it) }
        }

        ctx.prepareTask(provision)

        ctx.environmentConfig(project.provider {
            buildConfigNode(spec, resolveJavaPath(javaLauncherProvider))
        })
    }

    private fun buildConfigNode(spec: LocalEnvironmentSpec, javaPath: String): ConfigNode =
        ConfigNodeBuilder().also { fillConfig(it, spec, javaPath) }.build()

    private fun fillConfig(builder: ConfigNodeBuilder, spec: LocalEnvironmentSpec, javaPath: String) {
        val jvmArgs = spec.jvmArgs.get().toMutableList()
        if (spec.acceptEula.get() && jvmArgs.none { it.contains("eula.agree") }) {
            jvmArgs.add("-Dcom.mojang.eula.agree=true")
        }

        builder.put("serverJar", spec.runDir.get().file("server.jar").asFile.absolutePath)
        builder.put("serverDir", spec.runDir.get().asFile.absolutePath)
        builder.put("javaPath", javaPath)
        builder.putStrings("jvmArgs", jvmArgs)
        builder.put("minecraftVersion", spec.minecraftVersion.get())
        builder.put("host", "localhost")
        builder.put("port", spec.port.get())
    }

    private fun resolveJavaPath(javaLauncher: Provider<JavaLauncher>?): String {
        if (javaLauncher != null && javaLauncher.isPresent) {
            return javaLauncher.get().executablePath.asFile.absolutePath
        }
        val isWindows = System.getProperty("os.name").lowercase().contains("win")
        return File(System.getProperty("java.home"), "bin/java" + if (isWindows) ".exe" else "").absolutePath
    }
}
