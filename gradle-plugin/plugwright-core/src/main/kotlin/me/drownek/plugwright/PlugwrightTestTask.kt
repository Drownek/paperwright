package me.drownek.plugwright

import me.drownek.plugwright.api.ConfigNodeBuilder
import org.gradle.api.GradleException
import org.gradle.api.file.DirectoryProperty
import org.gradle.api.file.RegularFileProperty
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

    /** Name of the environment under test. Written into the runner config and into report names. */
    @get:Input
    abstract val environmentName: Property<String>

    /** Where the generated runner config is written before the CLI is invoked. */
    @get:OutputFile
    abstract val configFile: RegularFileProperty

    init {
        group = "verification"
        description = "Run E2E tests for Paper plugin"
        // Declaring the config file as an output must not make the run itself skippable:
        // the test result depends on the plugin, the server and the spec files alike.
        outputs.upToDateWhen { false }
    }

    @TaskAction
    fun runTests() {
        val nodePaths = resolveNode()
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

        val configDestination = configFile.get().asFile
        writeRunnerConfig(
            destination = configDestination,
            serverJar = serverJar.trim(),
            serverDirectory = serverDirectory.trim(),
            javaPath = javaPath,
            jvmArgs = finalJvmArgs,
            minecraftVersion = mcVersion,
            testsDirectory = userTestsDirectory
        )
        logger.lifecycle("Runner config: ${configDestination.absolutePath}")

        // The environment variables are the pre-3.0 transport. The runner prefers --config
        // and falls back to these, so an older runner still works with a newer plugin.
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
            nodePaths.node, cliJsFile.absolutePath, "--config", configDestination.absolutePath,
            env = envMap
        )

        logger.lifecycle("E2E tests completed successfully")
    }

    private fun writeRunnerConfig(
        destination: File,
        serverJar: String,
        serverDirectory: String,
        javaPath: String,
        jvmArgs: List<String>,
        minecraftVersion: String,
        testsDirectory: File
    ) {
        val envName = environmentName.get()
        val fileFilters = testFiles.orNull.splitFilter()
        val nameFilters = testNames.orNull.splitFilter()

        val root = ConfigNodeBuilder().apply {
            put("version", RunnerConfigWriter.CONFIG_VERSION)
            obj("environment") {
                put("name", envName)
                put("mode", "local")
                obj("config") {
                    put("serverJar", serverJar)
                    put("serverDir", serverDirectory)
                    put("javaPath", javaPath)
                    putStrings("jvmArgs", jvmArgs)
                    put("minecraftVersion", minecraftVersion)
                    // The bots connect to the server this task starts; the port still comes
                    // from server.properties defaults until environments can pick their own.
                    put("host", "localhost")
                    put("port", 25565)
                }
            }
            obj("tests") {
                put("dir", testsDirectory.absolutePath)
                if (fileFilters != null) putStrings("include", fileFilters) else putNull("include")
                if (nameFilters != null) putStrings("names", nameFilters) else putNull("names")
                putNull("exclude")
                // null means "runner default", which TEST_TIMEOUT can still override.
                putNull("timeoutMs")
            }
        }.build()

        RunnerConfigWriter.write(destination, root)
    }

    private fun String?.splitFilter(): List<String>? =
        this?.split(',')?.map { it.trim() }?.filter { it.isNotEmpty() }?.takeIf { it.isNotEmpty() }
}
