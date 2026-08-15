package me.drownek.plugwright.api

import java.io.File

/** Per-plugin options and inheritance flag, configured in the trailing lambda of [PluginsSpec.npm]
 *  / [PluginsSpec.local]. */
class PluginRefSpec {
    /** `options["loginCommand"] = "/login"` or `options.put("loginCommand", "/login")`. */
    val options: MutableMap<String, String> = linkedMapOf()

    /** Set false to load the plugin's hooks/matchers without pulling in its `tests`. */
    var inheritTests: Boolean = true
}

/**
 * `plugins { npm("@plugwright/auth-authme") { ... }; local(file("...")) { ... } }`.
 *
 * Declares runner plugins to load for an environment: fixtures, matchers, authentication
 * hooks, inherited tests. Lives in the API module rather than in one mode, because nothing
 * about a plugin is mode-specific — a mode only has to pass [entries] to
 * [TaskRegistrationContext.pluginConfigs] to support the block.
 */
class PluginsSpec {
    internal val entries = mutableListOf<PluginRef>()

    /** Entries declared so far, for a mode wiring them into its config. */
    fun refs(): List<PluginRef> = entries.toList()

    /** An npm-published plugin, e.g. `@plugwright/auth-authme`. */
    fun npm(specifier: String, action: PluginRefSpec.() -> Unit = {}) {
        val spec = PluginRefSpec().apply(action)
        entries.add(PluginRef(specifier, spec.options, spec.inheritTests))
    }

    /** A plugin living as a file in the test project, e.g. under `src/test/e2e`. */
    fun local(file: File, action: PluginRefSpec.() -> Unit = {}) {
        val spec = PluginRefSpec().apply(action)
        entries.add(PluginRef(file.absolutePath, spec.options, spec.inheritTests))
    }
}
