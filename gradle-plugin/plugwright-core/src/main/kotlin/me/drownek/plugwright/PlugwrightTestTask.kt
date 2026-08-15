package me.drownek.plugwright

import me.drownek.plugwright.api.ConfigNode
import me.drownek.plugwright.api.PluginRef
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

    /** Runner plugins this environment loads, from [me.drownek.plugwright.api.TaskRegistrationContext.pluginConfigs]. */
    @get:Internal
    abstract val pluginConfigs: ListProperty<PluginRef>

    /** Crash-recovery journal for this environment's run. */
    @get:Internal
    abstract val journalFile: RegularFileProperty

    /** Where the generated runner config is written before the CLI is invoked. */
    @get:OutputFile
    abstract val configFile: RegularFileProperty

    /** Where the runner writes its JSON report (`build/reports/plugwright/<env>.json`). */
    @get:OutputFile
    abstract val jsonReportFile: RegularFileProperty

    /** Where the runner writes its JUnit XML report (`build/reports/plugwright/junit/<env>.xml`). */
    @get:OutputFile
    abstract val junitReportFile: RegularFileProperty

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
        val entry = RunnerLauncher.Entry(
            environmentName = environmentName.get(),
            modeId = modeId.get(),
            environmentConfig = environmentConfig.get(),
            testsDir = userTestsDirectory,
            configFile = configDestination,
            testFiles = with(RunnerLauncher) { testFiles.orNull.splitFilter() },
            testNames = with(RunnerLauncher) { testNames.orNull.splitFilter() },
            excludeTests = if (excludeTests.isPresent) excludeTests.get() else emptyList(),
            jsonReportFile = jsonReportFile.get().asFile,
            junitReportFile = junitReportFile.get().asFile,
            pluginConfigs = pluginConfigs.get(),
            journalFile = journalFile.orNull?.asFile,
        )
        RunnerLauncher.writeConfig(entry)
        logger.lifecycle("Runner config: ${configDestination.absolutePath}")

        val cliJsFile = RunnerLauncher.resolveCliJs(userTestsDirectory)

        runCommand(userTestsDirectory, nodePaths.node, cliJsFile.absolutePath, "--config", configDestination.absolutePath)

        logger.lifecycle("E2E tests completed successfully")
    }
}
