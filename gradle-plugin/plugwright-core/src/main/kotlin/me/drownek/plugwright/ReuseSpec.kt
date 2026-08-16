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

    /** Whether a reused bot keeps its connection between the tests that borrow it. On by
     *  default, which is what reuse meant before this existed. `false` keeps the identity —
     *  account, nick, ability labels — but drops the connection at the end of every test and
     *  rejoins when a later one takes it: the only form of reuse a server that kicks idle bots
     *  allows. A single test can still override this with `reuse: { stay }`. */
    abstract val stay: Property<Boolean>

    init {
        enabled.convention(false)
        stay.convention(true)
    }
}
