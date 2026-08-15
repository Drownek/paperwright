package me.drownek.plugwright.local

import me.drownek.plugwright.AbstractNodeTask
import org.gradle.api.file.DirectoryProperty
import org.gradle.api.provider.ListProperty
import org.gradle.api.provider.Property
import org.gradle.api.tasks.*
import org.gradle.jvm.toolchain.JavaLauncher
import java.io.File

/** Starts the local Paper server interactively, for manual poking outside a test run. */
abstract class PlugwrightRunServerTask : AbstractNodeTask() {

    @get:InputDirectory
    abstract val runDir: DirectoryProperty

    @get:Input
    abstract val serverJarPath: Property<String>

    @get:Input
    abstract val jvmArgs: ListProperty<String>

    @get:Input
    abstract val acceptEula: Property<Boolean>

    @get:Nested
    @get:Optional
    abstract val javaLauncher: Property<JavaLauncher>

    init {
        group = "verification"
        description = "Start the test server for debugging"
    }

    @TaskAction
    fun runServer() {
        val runDirectory = runDir.get().asFile
        val serverJar = serverJarPath.get()
        val finalJvmArgs = jvmArgs.get().toMutableList()

        if (acceptEula.get() && finalJvmArgs.none { it.contains("eula.agree") }) {
            finalJvmArgs.add("-Dcom.mojang.eula.agree=true")
        }

        val javaPath = if (javaLauncher.isPresent) {
            javaLauncher.get().executablePath.asFile.absolutePath
        } else {
            val isWindows = System.getProperty("os.name").lowercase().contains("win")
            File(System.getProperty("java.home"), "bin/java" + if (isWindows) ".exe" else "").absolutePath
        }

        logger.lifecycle("Starting test server for debugging...")
        logger.lifecycle("Server JAR: $serverJar")
        logger.lifecycle("JVM Args: ${finalJvmArgs.joinToString(" ")}")

        val command = mutableListOf(javaPath)
        command.addAll(finalJvmArgs)
        command.addAll(listOf("-jar", serverJar, "nogui"))

        runCommand(runDirectory, *command.toTypedArray(), interactive = true) { line ->
            if (line.contains("For help, type \"help\"")) {
                logger.lifecycle("\n========================================================")
                logger.lifecycle(" 🚀 Server is Ready! Connect via localhost:25565 ")
                logger.lifecycle("========================================================\n")
            }
        }

        logger.lifecycle("Test server stopped")
    }
}
