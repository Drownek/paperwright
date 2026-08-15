package me.drownek.plugwright

import me.drownek.plugwright.local.LocalMode
import org.gradle.api.Plugin
import org.gradle.api.Project

/**
 * Entry point for the `io.github.drownek.plugwright` id.
 *
 * Applies the mode-agnostic engine and registers the built-in modes — just `local` for
 * now. A dedicated bundle module can take over this role once a second built-in mode
 * exists to combine with it.
 */
class PlugwrightPlugin : Plugin<Project> {
    override fun apply(project: Project) {
        project.pluginManager.apply(PlugwrightCorePlugin::class.java)
        val extension = project.extensions.getByType(PlugwrightExtension::class.java)
        extension.registerMode(LocalMode)
    }
}
