package me.drownek.plugwright

import org.gradle.api.file.DirectoryProperty
import org.gradle.api.provider.ListProperty
import org.gradle.api.tasks.Input
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

    /**
     * Packages the configured environments need at runtime, as npm install arguments
     * (`name` or `name@range`), merged across every environment so one install covers the
     * whole matrix. Only the missing ones are installed — a package the test project already
     * depends on (including a local `file:` link during development) is left alone.
     */
    @get:Input
    abstract val runnerPackages: ListProperty<String>

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

        installMissingRunnerPackages(userTestsDirectory, nodePaths, npmEnv)

        // Build TypeScript tests if tsconfig.json exists
        val tsconfigFile = File(userTestsDirectory, "tsconfig.json")
        if (tsconfigFile.exists()) {
            logger.lifecycle("TypeScript config found, compiling tests...")
            runCommand(userTestsDirectory, nodePaths.npm, "run", "build", env = npmEnv)
        } else {
            logger.lifecycle("No TypeScript config found, running JavaScript tests directly")
        }
    }

    private fun installMissingRunnerPackages(
        testsDirectory: File,
        nodePaths: NodeManager.NodePaths,
        npmEnv: Map<String, String>
    ) {
        val nodeModules = File(testsDirectory, "node_modules")
        val missing = runnerPackages.get().filterNot { spec ->
            File(nodeModules, packageNameOf(spec)).exists()
        }
        if (missing.isEmpty()) return

        logger.lifecycle("Installing runner packages: ${missing.joinToString(", ")}")
        try {
            // --no-save: these come from the build script's environments, so the test project's
            // package.json shouldn't grow a second, drifting copy of the same decision.
            runCommand(testsDirectory, nodePaths.npm, "install", "--no-save", *missing.toTypedArray(), env = npmEnv)
        } catch (e: Exception) {
            // A package that can't be installed is not a reason to stop compiling the tests:
            // only the environment that asked for it is affected, and the runner reports the
            // missing package with the context to fix it when that environment actually runs.
            logger.warn("Could not install runner packages ${missing.joinToString(", ")}: ${e.message}")
        }
    }

    /** `@scope/name@^1.0.0` → `@scope/name`; the version separator is the last `@`, which for
     *  a scoped package is never the leading one. */
    private fun packageNameOf(spec: String): String {
        val separator = spec.lastIndexOf('@')
        return if (separator > 0) spec.substring(0, separator) else spec
    }
}
