package me.drownek.plugwright.api

import java.io.Serializable

/**
 * An npm package the runner needs for a given environment, plus the export that
 * provides its [Environment factory][PlugwrightMode].
 *
 * The set of packages depends on the configuration, not only on the mode: an external
 * environment pulls the RCON console package only when the build script declares one.
 *
 * @param name npm package name, e.g. `@drownek/plugwright`
 * @param version npm version range; null means "whatever the test project already has"
 * @param export named export of the package holding the factory; null means the default export
 */
data class RunnerPackageRef @JvmOverloads constructor(
    val name: String,
    val version: String? = null,
    val export: String? = null
) : Serializable {
    companion object {
        private const val serialVersionUID: Long = 1L
    }
}
