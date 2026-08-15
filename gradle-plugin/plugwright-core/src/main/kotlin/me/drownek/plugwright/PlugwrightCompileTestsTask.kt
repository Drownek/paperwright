package me.drownek.plugwright

import org.gradle.api.file.DirectoryProperty
import org.gradle.api.tasks.InputDirectory
import org.gradle.api.tasks.Optional
import org.gradle.api.tasks.TaskAction
import java.io.File

/**
 * Installs the test project's npm dependencies and compiles its TypeScript.
 *
 * Split out of the test task so several environments share one install and one `tsc`
 * run instead of paying for them per environment.
 */
abstract class PlugwrightCompileTestsTask : AbstractNodeTask() {

    @get:InputDirectory
    @get:Optional
    abstract val testsDir: DirectoryProperty

    init {
        group = "verification"
        description = "Install npm dependencies and compile the E2E tests"
        // The compiled output depends on node_modules and on the installed runner package,
        // neither of which is a declared input, so never report this as up to date.
        outputs.upToDateWhen { false }
    }

    @TaskAction
    fun compile() {
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

        val nodePaths = resolveNode()
        val npmEnv = nodePathEnv(nodePaths)

        // Install dependencies if needed
        if (!File(userTestsDirectory, "node_modules").exists()) {
            logger.lifecycle("Installing Node.js dependencies...")
            runCommand(userTestsDirectory, nodePaths.npm, "install", env = npmEnv)
        }

        // Build TypeScript tests if tsconfig.json exists
        val tsconfigFile = File(userTestsDirectory, "tsconfig.json")
        if (tsconfigFile.exists()) {
            logger.lifecycle("TypeScript config found, compiling tests...")
            runCommand(userTestsDirectory, nodePaths.npm, "run", "build", env = npmEnv)
        } else {
            logger.lifecycle("No TypeScript config found, running JavaScript tests directly")
        }
    }
}
