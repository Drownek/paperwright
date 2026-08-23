package me.drownek.plugwright.api

import org.gradle.api.Project
import org.gradle.api.Task
import org.gradle.api.provider.Provider
import org.gradle.api.tasks.TaskProvider
import java.io.File
import kotlin.reflect.KClass

/**
 * Handed to [PlugwrightMode.registerTasks] so a mode can add its own tasks for one environment.
 *
 * Preparation work belongs in a task, not in a callback executed inside someone else's
 * `@TaskAction`: a task keeps the configuration cache intact, gets up-to-date checks, and
 * can be invoked by hand.
 */
interface TaskRegistrationContext {

    val project: Project

    /** Name of the environment these tasks belong to. */
    val environmentName: String

    /**
     * The jar of the plugin under test, from `shadowJar` / `reobfJar` / `jar`.
     *
     * Absent when the build asked for external plugins only, or when no jar-producing
     * task exists. Modes that do not install the plugin themselves ignore it.
     */
    val projectPluginJar: Provider<File>

    /** Directory the runner scans for spec files, same value `plugwrightTest<Environment>` uses. */
    val testsDir: Provider<File>

    /**
     * Registers a task named `plugwright<Suffix><Environment>`, e.g. `plugwrightProvisionLocal`
     * for `register("Provision", …)` in the `local` environment.
     */
    fun <T : Task> register(suffix: String, type: Class<T>, action: T.() -> Unit): TaskProvider<T>

    /**
     * Marks a task as the environment's preparation step. `plugwrightTest<Environment>` and
     * the matrix run it before the tests.
     */
    fun prepareTask(task: TaskProvider<out Task>)

    /**
     * Overrides the mode-specific part of this environment's runner config ([ConfigNode],
     * landing under `environment.config`), computed lazily at task execution time.
     *
     * Use this instead of [PlugwrightMode.serialize] when the value needs something only a
     * task can reach — a Gradle service such as the Java toolchain, for instance.
     */
    fun environmentConfig(node: Provider<ConfigNode>)

    /**
     * Declares the runner plugins this environment should load — the top-level `plugins`
     * array in the config, sibling to `environment.config` rather than part of it. Empty by
     * default; most modes have none.
     */
    fun pluginConfigs(refs: Provider<List<PluginRef>>)
}

/** Kotlin-friendly overload of [TaskRegistrationContext.register]. */
fun <T : Task> TaskRegistrationContext.register(
    suffix: String,
    type: KClass<T>,
    action: T.() -> Unit
): TaskProvider<T> = register(suffix, type.java, action)
