package me.drownek.plugwright.external

import me.drownek.plugwright.AbstractNodeTask
import me.drownek.plugwright.RunnerLauncher
import me.drownek.plugwright.api.ConfigNode
import org.gradle.api.file.RegularFileProperty
import org.gradle.api.provider.Property
import org.gradle.api.tasks.Input
import org.gradle.api.tasks.Internal
import org.gradle.api.tasks.OutputFile
import org.gradle.api.tasks.TaskAction
import java.io.File

/**
 * `plugwrightPing<Env>`: connects to the environment, probes its declared console channel(s)
 * in order, and verifies authentication — no test files are run. Meant as the first thing to
 * run against a new external stand, before trusting it with the real matrix.
 */
abstract class PlugwrightPingTask : AbstractNodeTask() {

    @get:Internal
    abstract val testsDir: Property<File>

    @get:Input
    abstract val environmentName: Property<String>

    @get:Input
    abstract val modeId: Property<String>

    @get:Internal
    abstract val environmentConfig: Property<ConfigNode>

    @get:OutputFile
    abstract val configFile: RegularFileProperty

    init {
        group = "verification"
        description = "Checks that an external environment is reachable and authentication works, without running tests."
        outputs.upToDateWhen { false }
    }

    @TaskAction
    fun ping() {
        val nodePaths = resolveNode()
        val userTestsDirectory = testsDir.get()

        val entry = RunnerLauncher.Entry(
            environmentName = environmentName.get(),
            modeId = modeId.get(),
            environmentConfig = environmentConfig.get(),
            testsDir = userTestsDirectory,
            configFile = configFile.get().asFile,
            testFiles = null,
            testNames = null,
            excludeTests = emptyList(),
        )
        RunnerLauncher.writeConfig(entry)
        logger.lifecycle("Runner config: ${entry.configFile.absolutePath}")

        val cliJsFile = RunnerLauncher.resolveCliJs(userTestsDirectory)
        runCommand(userTestsDirectory, nodePaths.node, cliJsFile.absolutePath, "--config", entry.configFile.absolutePath, "--ping")
    }
}
