package me.drownek.plugwright.local

import me.drownek.plugwright.api.EnvironmentSpec
import me.drownek.plugwright.api.RunDirFile
import org.gradle.api.file.DirectoryProperty
import org.gradle.api.model.ObjectFactory
import org.gradle.api.provider.ListProperty
import org.gradle.api.provider.Property
import java.io.File

/** Build-script description of a Paper server the runner downloads, patches, spawns and
 *  tears down itself, reachable at `localhost`. */
class LocalEnvironmentSpec(private val environmentName: String, objects: ObjectFactory) : EnvironmentSpec {

    override fun getName(): String = environmentName

    override val includeInMatrix: Property<Boolean> = objects.property(Boolean::class.java).convention(true)
    override val allowFailure: Property<Boolean> = objects.property(Boolean::class.java).convention(false)
    override val excludeTests: ListProperty<String> = objects.listProperty(String::class.java).convention(emptyList())

    /** Minecraft version for the Paper server (e.g., "1.19.4", "1.20.4"). */
    val minecraftVersion: Property<String> = objects.property(String::class.java).convention("1.19.4")

    /** JVM arguments to pass when starting the server. */
    val jvmArgs: ListProperty<String> = objects.listProperty(String::class.java).convention(listOf("-Xmx2G"))

    /** Whether to accept the Minecraft EULA automatically. */
    val acceptEula: Property<Boolean> = objects.property(Boolean::class.java).convention(true)

    /** Directory where the server will be run from. Created automatically if missing. */
    val runDir: DirectoryProperty = objects.directoryProperty()

    /** Port bots connect on. Currently always bound on `localhost`. */
    val port: Property<Int> = objects.property(Int::class.java).convention(25565)

    /** URLs of plugins to download before running tests. */
    val pluginUrls: ListProperty<String> = objects.listProperty(String::class.java).convention(emptyList())

    /** Files to write into the run directory before the server starts. Populated via [writeFiles]. */
    val runDirFiles: ListProperty<RunDirFile> = objects.listProperty(RunDirFile::class.java).convention(emptyList())

    /** Files/folders excluded from deletion during the clean task, relative to [runDir]. */
    val cleanExcludePatterns: ListProperty<String> = objects.listProperty(String::class.java).convention(
        listOf("server.jar", "cache", "libraries")
    )

    /** When true, the plugin under test is not built or installed automatically. */
    val useExternalPluginsOnly: Property<Boolean> = objects.property(Boolean::class.java).convention(false)

    /**
     * DSL method for configuring plugin downloads.
     * ```
     * downloadPlugins {
     *     url("https://example.com/plugin1.jar")
     * }
     * ```
     */
    fun downloadPlugins(action: PluginDownloadSpec.() -> Unit) {
        val spec = PluginDownloadSpec()
        action(spec)
        pluginUrls.set(spec.urls)
    }

    class PluginDownloadSpec {
        internal val urls = mutableListOf<String>()
        fun url(pluginUrl: String) {
            urls.add(pluginUrl)
        }
    }

    /**
     * DSL method for staging files into the run directory before server start. Paths are
     * relative to [runDir].
     */
    fun writeFiles(action: RunDirFileSpec.() -> Unit) {
        val spec = RunDirFileSpec()
        action(spec)
        runDirFiles.set(spec.entries)
    }

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
}
