package me.drownek.plugwright.api

import java.io.File

/**
 * The directories inside a plugwright workspace — the directory `plugwright.testsDir` points
 * at, `src/test/e2e` by default.
 *
 * ```
 * src/test/e2e/
 *   tests/            spec sources
 *   plugins/          runner plugin sources
 *   dist/             compiled output, mirroring the two directories above
 *   generated/<env>/  whatever an environment writes while it runs
 * ```
 *
 * Everything under `dist`, `generated` and `node_modules` is disposable: the build recreates
 * it, and `plugwrightInit` writes a `.gitignore` that keeps all three out of version control.
 *
 * A mode reads the layout through [TaskRegistrationContext.layout], and gets a chance to seed
 * spec defaults from it in [PlugwrightMode.applyLayoutDefaults].
 */
interface PlugwrightLayout {

    /** Root of the npm project: the value of `plugwright.testsDir`. */
    val workspaceDir: File

    /** Spec sources, `<workspace>/tests`. */
    val testsDir: File

    /** Runner plugin sources, `<workspace>/plugins`. */
    val pluginsDir: File

    /** Compiled output root, `<workspace>/dist`. */
    val compiledDir: File

    /** Compiled specs, `<workspace>/dist/tests`. */
    val compiledTestsDir: File

    /** Compiled runner plugins, `<workspace>/dist/plugins`. */
    val compiledPluginsDir: File

    /** Root of the per-environment scratch space, `<workspace>/generated`. */
    val generatedRootDir: File

    /** Where environment [environmentName] writes what it generates: `<workspace>/generated/<env>`.
     *  The local mode puts its server here; nothing else may write outside its own directory. */
    fun generatedDir(environmentName: String): File

    /**
     * The directory the runner scans for `.spec.js`: the compiled one once it exists, and the
     * sources otherwise — a workspace of plain JavaScript specs has nothing to compile.
     */
    fun runnableTestsDir(): File

    companion object {
        const val TESTS_DIR_NAME = "tests"
        const val PLUGINS_DIR_NAME = "plugins"
        const val COMPILED_DIR_NAME = "dist"
        const val GENERATED_DIR_NAME = "generated"

        /** The layout of the workspace rooted at [workspaceDir]. */
        fun of(workspaceDir: File): PlugwrightLayout = DefaultPlugwrightLayout(workspaceDir)
    }
}

private class DefaultPlugwrightLayout(override val workspaceDir: File) : PlugwrightLayout {
    override val testsDir: File get() = File(workspaceDir, PlugwrightLayout.TESTS_DIR_NAME)
    override val pluginsDir: File get() = File(workspaceDir, PlugwrightLayout.PLUGINS_DIR_NAME)
    override val compiledDir: File get() = File(workspaceDir, PlugwrightLayout.COMPILED_DIR_NAME)
    override val compiledTestsDir: File get() = File(compiledDir, PlugwrightLayout.TESTS_DIR_NAME)
    override val compiledPluginsDir: File get() = File(compiledDir, PlugwrightLayout.PLUGINS_DIR_NAME)
    override val generatedRootDir: File get() = File(workspaceDir, PlugwrightLayout.GENERATED_DIR_NAME)

    override fun generatedDir(environmentName: String): File = File(generatedRootDir, environmentName)

    override fun runnableTestsDir(): File = if (compiledTestsDir.exists()) compiledTestsDir else testsDir
}
