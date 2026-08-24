package me.drownek.plugwright

import com.google.gson.GsonBuilder
import com.google.gson.JsonArray
import com.google.gson.JsonObject
import com.google.gson.JsonParser
import me.drownek.plugwright.api.NpmConfig
import me.drownek.plugwright.api.PlugwrightLayout
import org.gradle.api.file.DirectoryProperty
import org.gradle.api.provider.ListProperty
import org.gradle.api.provider.Property
import org.gradle.api.tasks.Input
import org.gradle.api.tasks.Internal
import org.gradle.api.tasks.TaskAction
import java.io.File

/**
 * Installs the workspace's npm dependencies and compiles its TypeScript.
 *
 * Sources live in two directories — `tests` for specs, `plugins` for runner plugins — and
 * `tsc` mirrors both into `dist`. A workspace still holding its specs at the root (the layout
 * before `tests` existed) is moved into place the first time this task runs.
 *
 * Split out of the test task so several environments share one install and one `tsc`
 * run instead of paying for them per environment.
 */
abstract class PlugwrightCompileTestsTask : AbstractNodeTask() {

    /**
     * Root of the npm project: `plugwright.testsDir`.
     *
     * Not declared as an input directory: the task never reports itself up to date, and the
     * workspace holds `node_modules` and a running server's `generated` directory — fingerprinting
     * either of those costs seconds and decides nothing.
     */
    @get:Internal
    abstract val testsDir: DirectoryProperty

    /**
     * Packages the configured environments need at runtime, as npm install arguments
     * (`name` or `name@range`), merged across every environment so one install covers the
     * whole matrix. Only the missing ones are installed — a package the test project already
     * depends on (including a local `file:` link during development) is left alone.
     */
    @get:Input
    abstract val runnerPackages: ListProperty<String>

    /**
     * The registries npm should install from, from the build script's `npm { }` block.
     *
     * Holds [me.drownek.plugwright.api.SecretRef]s rather than credentials: the values are
     * read when the `.npmrc` is written, in [compile].
     */
    @get:Input
    abstract val npmConfig: Property<NpmConfig>

    init {
        group = "verification"
        description = "Install npm dependencies and compile the E2E tests"
        // The compiled output depends on node_modules and on the installed runner package,
        // neither of which is a declared input, so never report this as up to date.
        outputs.upToDateWhen { false }
    }

    @TaskAction
    fun compile() {
        val workspace = if (testsDir.isPresent) {
            testsDir.get().asFile
        } else {
            logger.warn("Tests directory not configured")
            return
        }

        if (!workspace.exists()) {
            logger.warn("Tests directory does not exist: ${workspace.absolutePath}")
            return
        }

        val layout = PlugwrightLayout.of(workspace)
        migrateRootLevelSpecs(layout)

        val nodePaths = resolveNode()
        val npmEnv = nodePathEnv(nodePaths)

        // Before any install: both the dependency install below and the runner packages after
        // it run with this workspace as their working directory, so one file covers both.
        NpmrcWriter.write(workspace, npmConfig.getOrElse(NpmConfig.EMPTY), logger)

        // Install dependencies if needed
        if (!File(workspace, "node_modules").exists()) {
            logger.lifecycle("Installing Node.js dependencies...")
            runCommand(workspace, nodePaths.npm, "install", env = npmEnv)
        }

        installMissingRunnerPackages(workspace, nodePaths, npmEnv)

        // Build TypeScript tests if tsconfig.json exists
        val tsconfigFile = File(workspace, "tsconfig.json")
        if (tsconfigFile.exists()) {
            logger.lifecycle("TypeScript config found, compiling tests...")
            runCommand(workspace, nodePaths.npm, "run", "build", env = npmEnv)
        } else {
            logger.lifecycle("No TypeScript config found, running JavaScript tests directly")
        }
    }

    // ---- Migration -------------------------------------------------------------------

    /**
     * Moves a workspace laid out the old way — specs anywhere under the root — into `tests`.
     *
     * Runs only while there is no `tests` directory at all, so it happens once and never
     * touches a workspace that already follows the layout. The `tsconfig.json` goes along
     * with the files: its `include` still describes where the specs used to be.
     */
    private fun migrateRootLevelSpecs(layout: PlugwrightLayout) {
        if (layout.testsDir.exists()) return

        val strays = findSpecSources(layout.workspaceDir, layout)
        if (strays.isEmpty()) return

        strays.forEach { source ->
            val destination = File(layout.testsDir, source.relativeTo(layout.workspaceDir).path)
            destination.parentFile.mkdirs()
            if (!source.renameTo(destination)) {
                source.copyTo(destination, overwrite = true)
                source.delete()
            }
        }
        removeEmptyDirectories(layout.workspaceDir, layout)

        logger.lifecycle(
            "Moved ${strays.size} spec file(s) into ${layout.testsDir.absolutePath} — " +
                "plugwright looks for specs under 'tests' now."
        )
        retargetTsConfig(layout)
    }

    /** Spec files outside the directories the layout owns; empty for a workspace that has
     *  already been migrated or was created by `plugwrightInit`. */
    private fun findSpecSources(directory: File, layout: PlugwrightLayout): List<File> {
        val children = directory.listFiles() ?: return emptyList()
        return children.flatMap { child ->
            when {
                child.isDirectory && isIgnoredDirectory(child, layout) -> emptyList()
                child.isDirectory -> findSpecSources(child, layout)
                child.name.endsWith(".spec.ts") || child.name.endsWith(".spec.js") -> listOf(child)
                else -> emptyList()
            }
        }
    }

    private fun isIgnoredDirectory(directory: File, layout: PlugwrightLayout): Boolean =
        directory.name == "node_modules" || directory.name == ".git" ||
            directory == layout.compiledDir || directory == layout.generatedRootDir ||
            directory == layout.pluginsDir || directory == layout.testsDir

    private fun removeEmptyDirectories(directory: File, layout: PlugwrightLayout) {
        val children = directory.listFiles() ?: return
        children.filter { it.isDirectory && !isIgnoredDirectory(it, layout) }.forEach { child ->
            removeEmptyDirectories(child, layout)
            if (child.list()?.isEmpty() == true) child.delete()
        }
    }

    /**
     * Points a migrated workspace's `tsconfig.json` at the directories the sources now live
     * in, and at the `dist` that mirrors them.
     *
     * A config the parser chokes on (comments are legal in `tsconfig.json`, and JSON says
     * otherwise) is left alone with an explanation — a rewrite that drops the comments is a
     * worse outcome than an edit by hand.
     */
    private fun retargetTsConfig(layout: PlugwrightLayout) {
        val tsconfigFile = File(layout.workspaceDir, "tsconfig.json")
        if (!tsconfigFile.exists()) return

        val config = try {
            JsonParser.parseString(tsconfigFile.readText()).asJsonObject
        } catch (e: Exception) {
            logger.warn(
                "Could not update ${tsconfigFile.absolutePath} (${e.message}). Point its \"include\" at " +
                    "\"tests/**/*.ts\" and \"plugins/**/*.ts\" by hand."
            )
            return
        }

        val compilerOptions = config.getAsJsonObject("compilerOptions") ?: JsonObject().also {
            config.add("compilerOptions", it)
        }
        compilerOptions.addProperty("rootDir", ".")
        compilerOptions.addProperty("outDir", "./${PlugwrightLayout.COMPILED_DIR_NAME}")
        config.add("include", jsonArrayOf(
            "${PlugwrightLayout.TESTS_DIR_NAME}/**/*.ts",
            "${PlugwrightLayout.PLUGINS_DIR_NAME}/**/*.ts",
        ))
        config.add("exclude", jsonArrayOf(
            "node_modules",
            PlugwrightLayout.COMPILED_DIR_NAME,
            PlugwrightLayout.GENERATED_DIR_NAME,
        ))

        tsconfigFile.writeText(GsonBuilder().setPrettyPrinting().create().toJson(config) + "\n")
        logger.lifecycle("Updated ${tsconfigFile.absolutePath} for the new layout")
    }

    private fun jsonArrayOf(vararg values: String): JsonArray =
        JsonArray().apply { values.forEach { add(it) } }

    // ---- npm -------------------------------------------------------------------------

    private fun installMissingRunnerPackages(
        workspace: File,
        nodePaths: NodeManager.NodePaths,
        npmEnv: Map<String, String>
    ) {
        val nodeModules = File(workspace, "node_modules")
        val missing = runnerPackages.get().filterNot { spec ->
            File(nodeModules, packageNameOf(spec)).exists()
        }
        if (missing.isEmpty()) return

        logger.lifecycle("Installing runner packages: ${missing.joinToString(", ")}")
        try {
            // --no-save: these come from the build script's environments, so the test project's
            // package.json shouldn't grow a second, drifting copy of the same decision.
            runCommand(workspace, nodePaths.npm, "install", "--no-save", *missing.toTypedArray(), env = npmEnv)
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
