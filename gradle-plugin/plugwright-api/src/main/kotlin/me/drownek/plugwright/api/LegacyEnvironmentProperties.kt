package me.drownek.plugwright.api

import org.gradle.api.file.DirectoryProperty
import org.gradle.api.provider.ListProperty
import org.gradle.api.provider.Property

/**
 * The pre-3.0 flat properties on the `plugwright { }` extension, kept so a build with no
 * `environments { }` block keeps working.
 *
 * A mode reads these in [PlugwrightMode.applyLegacyDefaults] to seed the environment it is
 * asked to create implicitly. Modes with no legacy shape simply ignore this.
 */
interface LegacyEnvironmentProperties {
    val minecraftVersion: Property<String>
    val jvmArgs: ListProperty<String>
    val acceptEula: Property<Boolean>
    val runDir: DirectoryProperty
    val pluginUrls: ListProperty<String>
    val runDirFiles: ListProperty<RunDirFile>
    val cleanExcludePatterns: ListProperty<String>
    val useExternalPluginsOnly: Property<Boolean>
}
