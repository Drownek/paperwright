package me.drownek.plugwright.api

/**
 * Version of the contract in this module.
 *
 * A mode declares the version it was compiled against via [PlugwrightMode.apiVersion].
 * Plugwright refuses to load a mode whose version it does not understand instead of
 * failing later with a [NoSuchMethodError] from a mismatched classpath.
 */
object PlugwrightApi {
    const val VERSION: Int = 1
}
