package me.drownek.plugwright

import org.gradle.api.provider.Property

/**
 * Settings for reusing a connected bot across test boundaries instead of reconnecting for
 * every test. Written into every environment's `tests.reuse`, the same way `MatrixSpec`
 * configures the matrix run rather than any one environment.
 */
abstract class ReuseSpec {

    /** Off by default: a project turns this on deliberately, so an existing suite that
     *  depends on a fresh player per test (a unique nick, no leftover op) keeps working
     *  unchanged until it opts in. */
    abstract val enabled: Property<Boolean>

    /** Live registry entries allowed at once. Unset means "runner default" — 4, or the
     *  environment's account pool capacity minus one when it has a pool. */
    abstract val maxPlayers: Property<Int>

    init {
        enabled.convention(false)
    }
}
