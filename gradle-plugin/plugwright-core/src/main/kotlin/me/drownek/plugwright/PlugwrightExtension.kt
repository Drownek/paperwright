package me.drownek.plugwright

import org.gradle.api.Project
import org.gradle.api.file.DirectoryProperty
import org.gradle.api.provider.ListProperty
import org.gradle.api.provider.Property
import java.io.File

abstract class PlugwrightExtension(project: Project) {
    /**
     * Directory containing test files (.spec.js)
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
     * Directory where the server will be run from.
     * Will be created automatically if it doesn't exist.
     */
    val runDir: DirectoryProperty = project.objects.directoryProperty().convention(
        project.layout.projectDirectory.dir("run")
    )

    /**
     * Minecraft version for the Paper server (e.g., "1.19.4", "1.20.4")
     */
    val minecraftVersion: Property<String> = project.objects.property(String::class.java).convention("1.19.4")

    /**
     * JVM arguments to pass when starting the server.
     */
    val jvmArgs: ListProperty<String> = project.objects.listProperty(String::class.java).convention(
        listOf(
            "-Xmx2G"
        )
    )

    /**
     * Whether to accept the Minecraft EULA automatically.
     * When true, adds -Dcom.mojang.eula.agree=true to JVM args.
     */
    val acceptEula: Property<Boolean> = project.objects.property(Boolean::class.java).convention(true)

    /**
     * List of files/folders to exclude from deletion during plugwrightClean.
     * By default, excludes server.jar, cache, and libraries folders.
     * These paths are relative to the run directory.
     */
    val cleanExcludePatterns: ListProperty<String> = project.objects.listProperty(String::class.java).convention(
        listOf(
            "server.jar",
            "cache",
            "libraries"
        )
    )

    /**
     * URLs of plugins to download before running tests.
     * These plugins will be placed in the server's plugins directory.
     */
    val pluginUrls: ListProperty<String> = project.objects.listProperty(String::class.java).convention(emptyList())

    /**
     * Whether to use only externally downloaded plugins instead of building the project plugin.
     * When true, the plugwrightTest task will not depend on jar/shadowJar/reobfJar tasks.
     * Useful when running E2E tests with plugins downloaded from external sources only.
     */
    val useExternalPluginsOnly: Property<Boolean> = project.objects.property(Boolean::class.java).convention(false)

    /**
     * List of files to write into the run directory before the server starts.
     * Internal storage — use the writeFiles { } DSL block to populate.
     */
    val runDirFiles: ListProperty<RunDirFile> = project.objects.listProperty(RunDirFile::class.java).convention(emptyList())

    /**
     * DSL method for staging files into the run directory before server start.
     *
     * Paths are relative to the run directory.
     *
     * Example:
     * ```
     * writeFiles {
     *     // inline text content
     *     file("plugins/SomePlugin/config.yml", """
     *         key: "value"
     *     """.trimIndent())
     *
     *     // copy from a local source file
     *     file("plugins/MyPlugin/data.json", projectDir.resolve("test-fixtures/data.json"))
     * }
     * ```
     */
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
     * Represents a single file to be written into the run directory.
     * Exactly one of [content] or [sourceFile] will be non-null.
     */
    data class RunDirFile(
        val path: String,
        val content: String?,
        val sourceFile: File?
    )

    /**
     * DSL method for configuring plugin downloads.
     * Example:
     * ```
     * downloadPlugins {
     *     url("https://example.com/plugin1.jar")
     *     url("https://example.com/plugin2.jar")
     * }
     * ```
     */
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
