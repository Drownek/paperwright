package me.drownek.plugwright

import com.google.gson.JsonParser
import me.drownek.plugwright.api.ConfigNode
import me.drownek.plugwright.api.PluginRef
import org.gradle.api.GradleException
import org.gradle.api.provider.Property
import org.gradle.api.provider.Provider
import org.gradle.api.tasks.Internal
import org.gradle.api.tasks.TaskAction
import java.io.File
import java.util.concurrent.Callable
import java.util.concurrent.Executors

/** Everything [PlugwrightMatrixTask] needs to launch one environment, resolved once at
 *  `afterEvaluate` in [PlugwrightCorePlugin] — the same shape [PlugwrightTestTask] uses,
 *  minus the Gradle task machinery this task doesn't need per-environment. */
internal data class MatrixEnvironmentInput(
    val name: String,
    val modeId: String,
    val allowFailure: Boolean,
    val workspaceDir: File,
    val configFile: File,
    val jsonReportFile: File,
    val junitReportFile: File,
    val logFile: File,
    val excludeTests: List<String>,
    val environmentConfig: Provider<ConfigNode>,
    val pluginConfigs: Provider<List<PluginRef>>,
    val runtimePackage: String? = null,
    val runtimeExport: String? = null,
)

private data class EnvironmentSummary(val total: Int, val passed: Int, val failed: Int, val skipped: Int, val durationMs: Long)

/**
 * `plugwrightTest`: runs every environment with `includeInMatrix = true`, one runner process
 * each, and aggregates the result. Does not `dependsOn` the per-environment `plugwrightTest<Env>`
 * tasks — it launches the same [RunnerLauncher] they use directly, so one environment failing
 * doesn't stop the others from reporting.
 */
abstract class PlugwrightMatrixTask : AbstractNodeTask() {

    @get:Internal
    internal var entries: List<MatrixEnvironmentInput> = emptyList()

    @get:Internal
    abstract val testFiles: Property<String>

    @get:Internal
    abstract val testNames: Property<String>

    @get:Internal
    abstract val parallel: Property<Boolean>

    @get:Internal
    abstract val maxParallel: Property<Int>

    init {
        group = "verification"
        description = "Runs plugwrightTest<Env> for every environment with includeInMatrix = true, and aggregates the result."
        outputs.upToDateWhen { false }
    }

    @TaskAction
    fun runMatrix() {
        val active = entries
        if (active.isEmpty()) {
            logger.lifecycle("plugwrightTest: no environment has includeInMatrix = true, nothing to run.")
            return
        }

        val nodePaths = resolveNode()
        val fileFilters = with(RunnerLauncher) { testFiles.orNull.splitFilter() }
        val nameFilters = with(RunnerLauncher) { testNames.orNull.splitFilter() }

        val outcomes = if (parallel.get() && active.size > 1) {
            val pool = Executors.newFixedThreadPool(maxParallel.get().coerceAtLeast(1))
            try {
                active.map { env -> pool.submit(Callable { runOne(env, nodePaths, fileFilters, nameFilters) }) }.map { it.get() }
            } finally {
                pool.shutdown()
            }
        } else {
            active.map { runOne(it, nodePaths, fileFilters, nameFilters) }
        }

        printSummaryTable(outcomes)

        val hardFailures = outcomes.filter { (env, summary, error) ->
            val environmentHadTrouble = error != null || summary == null || summary.failed > 0
            environmentHadTrouble && !env.allowFailure
        }
        if (hardFailures.isNotEmpty()) {
            throw GradleException(
                "plugwrightTest matrix failed: ${hardFailures.joinToString(", ") { it.env.name }}. " +
                    "See per-environment logs under build/reports/plugwright/."
            )
        }
    }

    private data class Outcome(val env: MatrixEnvironmentInput, val summary: EnvironmentSummary?, val error: Throwable?)

    private fun runOne(
        env: MatrixEnvironmentInput,
        nodePaths: NodeManager.NodePaths,
        fileFilters: List<String>?,
        nameFilters: List<String>?
    ): Outcome {
        logger.lifecycle("plugwrightTest [${env.name}]: starting")
        env.logFile.parentFile?.mkdirs()
        env.logFile.writeText("")

        return try {
            val entry = RunnerLauncher.Entry(
                environmentName = env.name,
                modeId = env.modeId,
                environmentConfig = env.environmentConfig.get(),
                workspaceDir = env.workspaceDir,
                configFile = env.configFile,
                testFiles = fileFilters,
                testNames = nameFilters,
                excludeTests = env.excludeTests,
                jsonReportFile = env.jsonReportFile,
                junitReportFile = env.junitReportFile,
                pluginConfigs = env.pluginConfigs.get(),
                runtimePackage = env.runtimePackage,
                runtimeExport = env.runtimeExport,
            )
            RunnerLauncher.writeConfig(entry)
            val cliJs = RunnerLauncher.resolveCliJs(env.workspaceDir)

            runCommand(
                env.workspaceDir, nodePaths.node, cliJs.absolutePath, "--config", entry.configFile.absolutePath,
                onStdoutLine = { line -> env.logFile.appendText(line + System.lineSeparator()) }
            )
            Outcome(env, readSummary(env.jsonReportFile), null)
        } catch (t: Throwable) {
            logger.error("plugwrightTest [${env.name}]: ${t.message}")
            Outcome(env, readSummary(env.jsonReportFile), t)
        }
    }

    private fun readSummary(file: File): EnvironmentSummary? {
        if (!file.exists()) return null
        return try {
            val root = JsonParser.parseString(file.readText()).asJsonObject
            val summary = root.getAsJsonObject("summary")
            EnvironmentSummary(
                total = summary.get("total").asInt,
                passed = summary.get("passed").asInt,
                failed = summary.get("failed").asInt,
                skipped = summary.get("skipped").asInt,
                durationMs = summary.get("durationMs").asLong,
            )
        } catch (_: Exception) {
            null
        }
    }

    private fun printSummaryTable(outcomes: List<Outcome>) {
        val nameWidth = outcomes.maxOf { it.env.name.length }
        logger.lifecycle("")
        logger.lifecycle("Environment summaries:")
        for ((env, summary, error) in outcomes) {
            val label = env.name.padEnd(nameWidth)
            val flag = if (env.allowFailure) "  [allowFailure]" else ""
            if (summary != null) {
                logger.lifecycle("  $label  ${summary.passed} passed, ${summary.failed} failed, ${summary.skipped} skipped   (${formatDuration(summary.durationMs)})$flag")
            } else {
                logger.lifecycle("  $label  ERROR: ${error?.message ?: "no report produced"}$flag")
            }
        }
        logger.lifecycle("")
    }

    private fun formatDuration(ms: Long): String {
        val totalSeconds = ms / 1000
        val minutes = totalSeconds / 60
        val seconds = totalSeconds % 60
        return if (minutes > 0) "${minutes}m ${seconds}s" else "${seconds}s"
    }
}
