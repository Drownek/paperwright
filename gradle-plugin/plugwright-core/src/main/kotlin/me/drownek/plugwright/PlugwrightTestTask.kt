package me.drownek.plugwright

import me.drownek.plugwright.api.ConfigNode
import me.drownek.plugwright.api.ConfigNodeBuilder
import org.gradle.api.GradleException
import org.gradle.api.file.DirectoryProperty
import org.gradle.api.file.RegularFileProperty
import org.gradle.api.provider.ListProperty
import org.gradle.api.provider.Property
import org.gradle.api.tasks.*
import java.io.File

/**
 * Runs the compiled test suite against one environment.
 *
 * Mode-agnostic: whichever mode owns this environment prepares whatever it needs through
 * its own tasks (wired in via [me.drownek.plugwright.api.TaskRegistrationContext.prepareTask])
 * and hands over the mode-specific part of the runner config through [environmentConfig].
 */
abstract class PlugwrightTestTask : AbstractNodeTask() {

    @get:InputDirectory
    @get:Optional
    abstract val testsDir: DirectoryProperty

    @get:Input
    @get:Optional
    abstract val testFiles: Property<String>

    @get:Input
    @get:Optional
    abstract val testNames: Property<String>

    /** Name of the environment under test. Written into the runner config and report names. */
    @get:Input
    abstract val environmentName: Property<String>

    /** Mode id this environment runs under (`local`, `external`, …). */
    @get:Input
    abstract val modeId: Property<String>

    /** Test name substrings to skip in this environment. */
    @get:Input
    @get:Optional
    abstract val excludeTests: ListProperty<String>

    /**
     * The mode-specific part of the runner config (`environment.config`). Set by the plugin
     * from either [me.drownek.plugwright.api.PlugwrightMode.serialize] or the mode's own
     * [me.drownek.plugwright.api.TaskRegistrationContext.environmentConfig] override.
     */
    @get:Internal
    abstract val environmentConfig: Property<ConfigNode>

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

        logger.lifecycle("Running E2E tests for environment '${environmentName.get()}'...")

        val configDestination = configFile.get().asFile
        writeRunnerConfig(configDestination, userTestsDirectory)
        logger.lifecycle("Runner config: ${configDestination.absolutePath}")

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

        runCommand(userTestsDirectory, nodePaths.node, cliJsFile.absolutePath, "--config", configDestination.absolutePath)

        logger.lifecycle("E2E tests completed successfully")
    }

    private fun writeRunnerConfig(destination: File, testsDirectory: File) {
        val fileFilters = testFiles.orNull.splitFilter()
        val nameFilters = testNames.orNull.splitFilter()
        val excludeList = if (excludeTests.isPresent) excludeTests.get() else emptyList()

        val root = ConfigNodeBuilder().apply {
            put("version", RunnerConfigWriter.CONFIG_VERSION)
            obj("environment") {
                put("name", environmentName.get())
                put("mode", modeId.get())
                put("config", environmentConfig.get())
            }
            obj("tests") {
                put("dir", testsDirectory.absolutePath)
                if (fileFilters != null) putStrings("include", fileFilters) else putNull("include")
                if (nameFilters != null) putStrings("names", nameFilters) else putNull("names")
                if (excludeList.isNotEmpty()) putStrings("exclude", excludeList) else putNull("exclude")
                // null means "runner default", which TEST_TIMEOUT can still override.
                putNull("timeoutMs")
            }
        }.build()

        RunnerConfigWriter.write(destination, root)
    }

    private fun String?.splitFilter(): List<String>? =
        this?.split(',')?.map { it.trim() }?.filter { it.isNotEmpty() }?.takeIf { it.isNotEmpty() }
}
