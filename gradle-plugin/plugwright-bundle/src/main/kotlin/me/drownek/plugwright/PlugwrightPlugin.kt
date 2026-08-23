package me.drownek.plugwright

import me.drownek.plugwright.external.ExternalMode
import me.drownek.plugwright.local.LocalMode
import org.gradle.api.Plugin
import org.gradle.api.Project

/**
 * Entry point for the `io.github.drownek.plugwright` id.
 *
 * Applies the mode-agnostic engine and registers both built-in modes: `local` and `external`.
 * A third-party mode registers itself the same way, from its own plugin or from the build
 * script directly, via `plugwright.registerMode(...)`.
 */
class PlugwrightPlugin : Plugin<Project> {
    override fun apply(project: Project) {
        project.pluginManager.apply(PlugwrightCorePlugin::class.java)
        val extension = project.extensions.getByType(PlugwrightExtension::class.java)
        extension.registerMode(LocalMode)
        extension.registerMode(ExternalMode)
    }
}
