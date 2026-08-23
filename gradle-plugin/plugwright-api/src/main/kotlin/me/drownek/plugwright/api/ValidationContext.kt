package me.drownek.plugwright.api

/**
 * Collects configuration-time problems found by [PlugwrightMode.validate].
 *
 * Modes report through this instead of throwing so one build failure can list every
 * problem in every environment at once.
 */
interface ValidationContext {

    /** Environment being validated. */
    val environmentName: String

    /** Records a problem that must fail the build. */
    fun error(message: String)

    /** Records a problem worth printing that does not fail the build. */
    fun warn(message: String)
}
