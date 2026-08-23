package me.drownek.plugwright

import me.drownek.plugwright.api.ConfigNode
import me.drownek.plugwright.api.ConfigNodeBuilder
import me.drownek.plugwright.api.PluginRef
import org.gradle.api.GradleException
import java.io.File

/**
 * Config-writing and `cli.js` resolution shared by [PlugwrightTestTask] (one environment),
 * [PlugwrightMatrixTask] (many, in one process each), and the service tasks a mode registers
 * for itself (ping, compensating cleanup). Process execution itself stays on
 * [AbstractNodeTask] — every task type here extends it and already has `runCommand`/`resolveNode`.
 */
object RunnerLauncher {

    /** Everything needed to write one environment's `config.json` and locate its `cli.js`.
     *  [jsonReportFile]/[junitReportFile] are omitted for service runs (`--ping`, `--cleanup`)
     *  that never produce a report. */
    data class Entry(
        val environmentName: String,
        val modeId: String,
        val environmentConfig: ConfigNode,
        val testsDir: File,
        val configFile: File,
        val testFiles: List<String>?,
        val testNames: List<String>?,
        val excludeTests: List<String>,
        val jsonReportFile: File? = null,
        val junitReportFile: File? = null,
        val pluginConfigs: List<PluginRef> = emptyList(),
        /** Crash-recovery journal path for `Session.journal`; null disables on-disk persistence. */
        val journalFile: File? = null,
    )

    fun writeConfig(entry: Entry) {
        val root = ConfigNodeBuilder().apply {
            put("version", RunnerConfigWriter.CONFIG_VERSION)
            obj("environment") {
                put("name", entry.environmentName)
                put("mode", entry.modeId)
                put("config", entry.environmentConfig)
            }
            obj("tests") {
                put("dir", entry.testsDir.absolutePath)
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
            entry.journalFile?.let { put("journal", it.absolutePath) } ?: putNull("journal")
        }.build()

        RunnerConfigWriter.write(entry.configFile, root)
    }

    /** Resolves `cli.js` relative to a test project's `node_modules`, falling back to the
     *  in-repo build for `example_plugin`-style development setups. */
    fun resolveCliJs(testsDir: File): File {
        val defaultCliJs = File(testsDir, "node_modules/@drownek/plugwright/dist/cli.js")
        return sequenceOf(
            // Canonical path resolves npm symlink bugs on CI
            defaultCliJs.canonicalFile,
            defaultCliJs,
            // Dev-environment fallback when running inside this repository
            File(testsDir, "../../../../runner-package/dist/cli.js")
        ).firstOrNull { it.exists() }
            ?: throw GradleException(
                "plugwright cli.js not found at ${defaultCliJs.absolutePath}. " +
                    "Did 'npm install' succeed in ${testsDir.absolutePath}?"
            )
    }

    /** Splits a comma-separated `-P` property value the same way for every task. */
    fun String?.splitFilter(): List<String>? =
        this?.split(',')?.map { it.trim() }?.filter { it.isNotEmpty() }?.takeIf { it.isNotEmpty() }
}
