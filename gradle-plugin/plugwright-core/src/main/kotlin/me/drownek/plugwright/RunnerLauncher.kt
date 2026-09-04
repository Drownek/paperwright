package me.drownek.plugwright

import me.drownek.plugwright.api.ConfigNode
import me.drownek.plugwright.api.ConfigNodeBuilder
import me.drownek.plugwright.api.PluginRef
import me.drownek.plugwright.api.PlugwrightLayout
import org.gradle.api.GradleException
import java.io.File

/**
 * Config-writing and `cli.js` resolution shared by [PlugwrightTestTask] (one environment),
 * [PlugwrightMatrixTask] (many, in one process each), and the service tasks a mode registers
 * for itself (ping). Process execution itself stays on
 * [AbstractNodeTask] — every task type here extends it and already has `runCommand`/`resolveNode`.
 */
object RunnerLauncher {

    /** Everything needed to write one environment's `config.json` and locate its `cli.js`.
     *  [jsonReportFile]/[junitReportFile] are omitted for service runs (`--ping`)
     *  that never produce a report. */
    data class Entry(
        val environmentName: String,
        val modeId: String,
        val environmentConfig: ConfigNode,
        /** Root of the npm project. The directory the runner actually scans is derived from
         *  it — see [PlugwrightLayout.runnableTestsDir]. */
        val workspaceDir: File,
        val configFile: File,
        val testFiles: List<String>?,
        val testNames: List<String>?,
        val excludeTests: List<String>,
        val jsonReportFile: File? = null,
        val junitReportFile: File? = null,
        val pluginConfigs: List<PluginRef> = emptyList(),
        /** npm package exporting this environment's factory; null for a built-in mode. */
        val runtimePackage: String? = null,
        /** Named export holding the factory; null means the package's default export. */
        val runtimeExport: String? = null,
    )

    fun writeConfig(entry: Entry) {
        val root = ConfigNodeBuilder().apply {
            put("version", RunnerConfigWriter.CONFIG_VERSION)
            obj("environment") {
                put("name", entry.environmentName)
                put("mode", entry.modeId)
                // Where the runner loads the environment implementation from. The built-in
                // modes are compiled into the runner and ignore it; a third-party mode is
                // only reachable through this reference.
                if (entry.runtimePackage != null) {
                    obj("runtime") {
                        put("package", entry.runtimePackage)
                        putIfPresent("export", entry.runtimeExport)
                    }
                } else {
                    putNull("runtime")
                }
                put("config", entry.environmentConfig)
            }
            obj("tests") {
                put("dir", PlugwrightLayout.of(entry.workspaceDir).runnableTestsDir().absolutePath)
                if (entry.testFiles != null) putStrings("include", entry.testFiles) else putNull("include")
                if (entry.testNames != null) putStrings("names", entry.testNames) else putNull("names")
                if (entry.excludeTests.isNotEmpty()) putStrings("exclude", entry.excludeTests) else putNull("exclude")
                // null means "runner default", which TEST_TIMEOUT can still override.
                putNull("timeoutMs")
            }
            if (entry.jsonReportFile != null || entry.junitReportFile != null) {
                obj("reports") {
                    entry.jsonReportFile?.let { put("json", it.absolutePath) }
                    entry.junitReportFile?.let { put("junit", it.absolutePath) }
                }
            }
            if (entry.pluginConfigs.isNotEmpty()) {
                array("plugins") {
                    entry.pluginConfigs.forEach { ref ->
                        obj {
                            put("specifier", ref.specifier)
                            put("inheritTests", ref.inheritTests)
                            if (ref.options.isNotEmpty()) {
                                obj("options") { ref.options.forEach { (k, v) -> put(k, v) } }
                            }
                        }
                    }
                }
            }
        }.build()

        RunnerConfigWriter.write(entry.configFile, root)
    }

    /** Resolves `cli.js` relative to the workspace's `node_modules`, falling back to the
     *  in-repo build for `example_plugin`-style development setups. */
    fun resolveCliJs(workspaceDir: File): File {
        val defaultCliJs = File(workspaceDir, "node_modules/@plugwright/runner/dist/cli.js")
        return sequenceOf(
            // Canonical path resolves npm symlink bugs on CI
            defaultCliJs.canonicalFile,
            defaultCliJs,
            // Dev-environment fallback when running inside this repository
            File(workspaceDir, "../../../../runner-package/dist/cli.js")
        ).firstOrNull { it.exists() }
            ?: throw GradleException(
                "plugwright cli.js not found at ${defaultCliJs.absolutePath}. " +
                    "Did 'npm install' succeed in ${workspaceDir.absolutePath}?"
            )
    }

    /** Splits a comma-separated `-P` property value the same way for every task. */
    fun String?.splitFilter(): List<String>? =
        this?.split(',')?.map { it.trim() }?.filter { it.isNotEmpty() }?.takeIf { it.isNotEmpty() }
}
