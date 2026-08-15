package me.drownek.plugwright

import org.gradle.api.tasks.TaskAction
import java.io.File

abstract class PlugwrightRunTask : AbstractPlugwrightTask() {

    init {
        group = "verification"
        description = "Start the test server for debugging"
    }

    @TaskAction
    fun runServer() {
        val runDirectory = prepareServerEnvironment()
        
        val serverJar = serverJarPath.get()
        val serverArgs = jvmArgs.get()
        val shouldAcceptEula = acceptEula.get()

        // Build JVM arguments string
        val finalJvmArgs = serverArgs.toMutableList()
        
        // Ensure EULA argument is present if acceptEula is true
        if (shouldAcceptEula && !finalJvmArgs.any { it.contains("eula.agree") }) {
            finalJvmArgs.add("-Dcom.mojang.eula.agree=true")
        }
        
        val javaPath = if (javaLauncher.isPresent) {
            javaLauncher.get().executablePath.asFile.absolutePath
        } else {
            File(System.getProperty("java.home"), "bin/java" + if (System.getProperty("os.name").lowercase().contains("win")) ".exe" else "").absolutePath
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
