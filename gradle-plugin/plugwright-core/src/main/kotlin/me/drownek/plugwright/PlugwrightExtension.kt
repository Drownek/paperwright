package me.drownek.plugwright

import me.drownek.plugwright.api.LegacyEnvironmentProperties
import me.drownek.plugwright.api.PlugwrightMode
import me.drownek.plugwright.api.RunDirFile
import org.gradle.api.Project
import org.gradle.api.file.DirectoryProperty
import org.gradle.api.provider.ListProperty
import org.gradle.api.provider.Property
import java.io.File

abstract class PlugwrightExtension(project: Project) : LegacyEnvironmentProperties {
    /**
     * Directory containing test files (.spec.js / .spec.ts)
     */
    val testsDir: DirectoryProperty = project.objects.directoryProperty().convention(
        project.layout.projectDirectory.dir("src/test/e2e")
    )

    /**
     * The Node.js version to download and use if downloadNode is true.
     */
    val nodeVersion: Property<String> = project.objects.property(String::class.java).convention("22.14.0")

    /**
     * Whether to automatically download Node.js. Disabled by default: the system-installed
     * node/npm on PATH is used, and the build fails with instructions if Node.js is missing.
     * Set to true to download a verified Node.js distribution into a shared per-user cache.
     */
    val downloadNode: Property<Boolean> = project.objects.property(Boolean::class.java).convention(false)

    /**
     * Environment the unsuffixed task aliases (`plugwrightTest`, `plugwrightClean`, …) point
     * at. Only meaningful once more than one environment is declared.
     */
    val primaryEnvironment: Property<String> = project.objects.property(String::class.java).convention(DEFAULT_ENVIRONMENT_NAME)

    /**
     * Mode registry and declared environments. See [registerMode] and [environments].
     */
    val environments: EnvironmentContainer = EnvironmentContainer(project.objects)

    /** Registers a [PlugwrightMode] so [environments] can create environments of its spec type. */
    fun registerMode(mode: PlugwrightMode<*>) {
        environments.registerMode(mode)
    }

    /** Declares the environments tests can run against. */
    fun environments(action: EnvironmentContainer.() -> Unit) {
        environments.action()
    }

    /** Settings for `plugwrightTest`'s multi-environment matrix run. See [matrix]. */
    val matrix: MatrixSpec = project.objects.newInstance(MatrixSpec::class.java)

    /** Configures the matrix run: `matrix { parallel.set(true); maxParallel.set(2) }`. */
    fun matrix(action: MatrixSpec.() -> Unit) {
        matrix.action()
    }

    // ---- Deprecated flat properties --------------------------------------------------
    // Pre-3.0 shape: describes a single implicit "local" environment. Still read whenever
    // the build script has no environments { } block — see PlugwrightMode.applyLegacyDefaults.

    @Deprecated("Use environments { create(\"local\", LocalMode) { minecraftVersion.set(...) } }")
    override val minecraftVersion: Property<String> = project.objects.property(String::class.java).convention("1.19.4")

    @Deprecated("Use environments { create(\"local\", LocalMode) { jvmArgs.set(...) } }")
    override val jvmArgs: ListProperty<String> = project.objects.listProperty(String::class.java).convention(
        listOf("-Xmx2G")
    )

    @Deprecated("Use environments { create(\"local\", LocalMode) { acceptEula.set(...) } }")
    override val acceptEula: Property<Boolean> = project.objects.property(Boolean::class.java).convention(true)

    @Deprecated("Use environments { create(\"local\", LocalMode) { runDir.set(...) } }")
    override val runDir: DirectoryProperty = project.objects.directoryProperty().convention(
        project.layout.projectDirectory.dir("run")
    )

    @Deprecated("Use environments { create(\"local\", LocalMode) { cleanExcludePatterns.set(...) } }")
    override val cleanExcludePatterns: ListProperty<String> = project.objects.listProperty(String::class.java).convention(
        listOf("server.jar", "cache", "libraries")
    )

    @Deprecated("Use environments { create(\"local\", LocalMode) { downloadPlugins { ... } } }")
    override val pluginUrls: ListProperty<String> = project.objects.listProperty(String::class.java).convention(emptyList())

    @Deprecated("Use environments { create(\"local\", LocalMode) { useExternalPluginsOnly.set(...) } }")
    override val useExternalPluginsOnly: Property<Boolean> = project.objects.property(Boolean::class.java).convention(false)

    @Deprecated("Use environments { create(\"local\", LocalMode) { writeFiles { ... } } }")
    override val runDirFiles: ListProperty<RunDirFile> = project.objects.listProperty(RunDirFile::class.java).convention(emptyList())

    /**
     * DSL method for staging files into the run directory before server start.
     *
     * Paths are relative to the run directory.
     */
    @Deprecated("Use environments { create(\"local\", LocalMode) { writeFiles { ... } } }")
    fun writeFiles(action: RunDirFileSpec.() -> Unit) {
        val spec = RunDirFileSpec()
        action(spec)
        runDirFiles.set(spec.entries)
    }

    /**
     * Specification for run-dir file staging.
     */
    class RunDirFileSpec {
        internal val entries = mutableListOf<RunDirFile>()

        /** Write [content] (as UTF-8 text) to [path] relative to the run directory. */
        fun file(path: String, content: String) {
            entries.add(RunDirFile(path, content, null))
        }

        /** Copy [sourceFile] to [path] relative to the run directory. */
        fun file(path: String, sourceFile: File) {
            entries.add(RunDirFile(path, null, sourceFile))
        }
    }

    /**
     * DSL method for configuring plugin downloads.
     */
    @Deprecated("Use environments { create(\"local\", LocalMode) { downloadPlugins { ... } } }")
    fun downloadPlugins(action: PluginDownloadSpec.() -> Unit) {
        val spec = PluginDownloadSpec()
        action(spec)
        pluginUrls.set(spec.urls)
    }

    /**
     * Specification for plugin downloads.
     */
    class PluginDownloadSpec {
        internal val urls = mutableListOf<String>()

        /**
         * Add a plugin URL to download.
         */
        fun url(pluginUrl: String) {
            urls.add(pluginUrl)
        }
    }
}
