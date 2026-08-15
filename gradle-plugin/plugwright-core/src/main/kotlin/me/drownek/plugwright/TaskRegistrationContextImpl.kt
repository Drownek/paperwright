package me.drownek.plugwright

import me.drownek.plugwright.api.ConfigNode
import me.drownek.plugwright.api.TaskRegistrationContext
import org.gradle.api.Project
import org.gradle.api.Task
import org.gradle.api.provider.Provider
import org.gradle.api.tasks.TaskProvider
import java.io.File

/**
 * A task registered through [register] gets a name of the form `plugwright<Suffix><Env>`.
 * When [environmentName] is the build's primary environment, the first registration of a
 * given suffix also gets a bare `plugwright<Suffix>` alias.
 */
internal class TaskRegistrationContextImpl(
    override val project: Project,
    override val environmentName: String,
    private val isPrimary: Boolean,
    override val projectPluginJar: Provider<File>
) : TaskRegistrationContext {

    /** Set by [prepareTask]; read by the plugin once every mode has registered its tasks. */
    var prepareTaskRef: TaskProvider<out Task>? = null
        private set

    /** Set by [environmentConfig]; when null, the plugin falls back to [me.drownek.plugwright.api.PlugwrightMode.serialize]. */
    var environmentConfigProvider: Provider<ConfigNode>? = null
        private set

    private val aliasedSuffixes = mutableSetOf<String>()

    override fun <T : Task> register(suffix: String, type: Class<T>, action: T.() -> Unit): TaskProvider<T> {
        val envSuffix = environmentName.replaceFirstChar { it.uppercaseChar() }
        val taskName = "plugwright$suffix$envSuffix"
        val provider = project.tasks.register(taskName, type) { action() }

        if (isPrimary && aliasedSuffixes.add(suffix)) {
            val aliasName = "plugwright$suffix"
            if (project.tasks.findByName(aliasName) == null) {
                project.tasks.register(aliasName) {
                    group = "verification"
                    description = "Alias for $taskName (primary environment '$environmentName')"
                    dependsOn(provider)
                }
            }
        }
        return provider
    }

    override fun prepareTask(task: TaskProvider<out Task>) {
        prepareTaskRef = task
    }

    override fun environmentConfig(node: Provider<ConfigNode>) {
        environmentConfigProvider = node
    }
}
