package me.drownek.plugwright

import org.gradle.api.GradleException
import org.gradle.api.file.DirectoryProperty
import org.gradle.api.provider.Property
import org.gradle.api.tasks.*
import java.io.File

abstract class PlugwrightTestTask : AbstractPlugwrightTask() {

    @get:InputDirectory
    @get:Optional
    abstract val testsDir: DirectoryProperty

    @get:Input
    @get:Optional
    abstract val testFiles: Property<String>

    @get:Input
    @get:Optional
    abstract val testNames: Property<String>

    init {
        group = "verification"
        description = "Run E2E tests for Paper plugin"
    }

    @TaskAction
    fun runTests() {
        val nodePaths = NodeManager.getOrDownloadNode(nodeInstallDir.get().asFile, nodeVersion.get(), downloadNode.get())
        prepareServerEnvironment()

        val serverJar = serverJarPath.get()
        val serverDirectory = serverDir.get()
        val mcVersion = minecraftVersion.get()
        val serverArgs = jvmArgs.get()
        val shouldAcceptEula = acceptEula.get()

        // Check tests directory
        val userTestsDirectory = if (testsDir.isPresent) {
            testsDir.get().asFile
        } else {
            logger.warn("Tests directory not configured")
            return
        }
        
        if (!userTestsDirectory.exists()) {
            logger.warn("Tests directory does not exist: ${userTestsDirectory.absolutePath}")
            return
        }

        // Install dependencies if needed
        if (!File(userTestsDirectory, "node_modules").exists()) {
            logger.lifecycle("Installing Node.js dependencies...")
            runCommand(userTestsDirectory, nodePaths.npm, "install")
        }

        // Build TypeScript tests if tsconfig.json exists
        val tsconfigFile = File(userTestsDirectory, "tsconfig.json")
        if (tsconfigFile.exists()) {
            logger.lifecycle("TypeScript config found, compiling tests...")
            runCommand(userTestsDirectory, nodePaths.npm, "run", "build")
        } else {
            logger.lifecycle("No TypeScript config found, running JavaScript tests directly")
        }

        // Build JVM arguments string for the runner
        val finalJvmArgs = serverArgs.toMutableList()
        
        // Ensure EULA argument is present if acceptEula is true
        if (shouldAcceptEula && !finalJvmArgs.any { it.contains("eula.agree") }) {
            finalJvmArgs.add("-Dcom.mojang.eula.agree=true")
        }
        
        val jvmArgsString = finalJvmArgs.joinToString(" ")

        // Run Tests using the npm package
        val javaPath = if (javaLauncher.isPresent) {
            javaLauncher.get().executablePath.asFile.absolutePath
        } else {
            File(System.getProperty("java.home"), "bin/java" + if (System.getProperty("os.name").lowercase().contains("win")) ".exe" else "").absolutePath
        }

        logger.lifecycle("Running E2E tests...")
        logger.lifecycle("Server JAR: $serverJar")
        logger.lifecycle("JVM Args: $jvmArgsString")

        val envMap = mutableMapOf(
            "SERVER_JAR" to serverJar.trim(),
            "SERVER_DIR" to serverDirectory.trim(),
            "JAVA_PATH" to javaPath,
            "JVM_ARGS" to jvmArgsString,
            "MC_VERSION" to mcVersion
        )

        if (testFiles.isPresent) {
            val fileFilter = testFiles.get()
            envMap["TEST_FILES"] = fileFilter
            logger.lifecycle("Test files filter: $fileFilter")
        }

        if (testNames.isPresent) {
            val nameFilter = testNames.get()
            envMap["TEST_NAMES"] = nameFilter
            logger.lifecycle("Test names filter: $nameFilter")
        }

        val defaultCliJs = File(userTestsDirectory, "node_modules/@drownek/plugwright/dist/cli.js")
        val cliJsFile = sequenceOf(
            // Canonical path resolves npm symlink bugs on CI
            defaultCliJs.canonicalFile,
            defaultCliJs,
            // Dev-environment fallback when running inside this repository
            File(userTestsDirectory, "../../../../runner-package/dist/cli.js")
        ).firstOrNull { it.exists() }
            ?: throw GradleException(
                "plugwright cli.js not found at ${defaultCliJs.absolutePath}. " +
                    "Did 'npm install' succeed in ${userTestsDirectory.absolutePath}?"
            )

        runCommand(
            userTestsDirectory, 
            nodePaths.node, cliJsFile.absolutePath,
            env = envMap
        )
        
        logger.lifecycle("E2E tests completed successfully")
    }
}
