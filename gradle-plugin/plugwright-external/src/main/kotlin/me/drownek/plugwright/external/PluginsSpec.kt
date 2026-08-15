package me.drownek.plugwright.external

import me.drownek.plugwright.api.PluginRef
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
 * Declares runner plugins to load for this environment: fixtures, matchers, authentication
 * hooks, inherited tests. See the runner's own plugin contract for what a plugin can do once
 * loaded.
 */
class PluginsSpec {
    internal val entries = mutableListOf<PluginRef>()

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
