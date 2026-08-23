package me.drownek.plugwright.api

import java.io.Serializable

/**
 * One runner plugin to load: an npm package name or a resolvable local file path, plus its
 * options and whether its declared `tests` are inherited into the run.
 *
 * Lands in the top-level `plugins` array of the runner config — a sibling of `environment`,
 * not part of `environment.config` — via [TaskRegistrationContext.pluginConfigs].
 */
data class PluginRef @JvmOverloads constructor(
    val specifier: String,
    val options: Map<String, String> = emptyMap(),
    val inheritTests: Boolean = true
) : Serializable {
    companion object {
        private const val serialVersionUID: Long = 1L
    }
}
