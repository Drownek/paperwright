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
 * `plugwrightClean<Env>` for a mode with a compensating cleanup strategy: no run directory to
 * wipe, so instead this runs every loaded plugin's `cleanup({ scope: 'manual' })` handler and
 * replays whatever the crash-recovery journal still has outstanding — entries a prior run's
 * `finally` never reached because the process died first.
 */
abstract class PlugwrightCleanupTask : AbstractNodeTask() {

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

    @get:Internal
    abstract val journalFile: RegularFileProperty

    init {
        group = "verification"
        description = "Runs compensating cleanup and replays the crash-recovery journal for an external environment."
        outputs.upToDateWhen { false }
    }

    @TaskAction
    fun cleanup() {
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
            journalFile = journalFile.orNull?.asFile,
        )
        RunnerLauncher.writeConfig(entry)
        logger.lifecycle("Runner config: ${entry.configFile.absolutePath}")

        val cliJsFile = RunnerLauncher.resolveCliJs(userTestsDirectory)
        runCommand(userTestsDirectory, nodePaths.node, cliJsFile.absolutePath, "--config", entry.configFile.absolutePath, "--cleanup")
    }
}
