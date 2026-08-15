package me.drownek.plugwright

import org.gradle.api.provider.Property

/**
 * Settings for the `plugwrightTest` matrix run: every environment with `includeInMatrix = true`,
 * aggregated into one summary.
 */
abstract class MatrixSpec {

    /**
     * Runs environments concurrently instead of one after another. Off by default: two local
     * Paper servers double the `-Xmx` footprint, and a shared external IP intensifies
     * join-throttle contention and ban risk on a public stand.
     */
    abstract val parallel: Property<Boolean>

    /** Upper bound on concurrent environment runs when [parallel] is enabled. */
    abstract val maxParallel: Property<Int>

    init {
        parallel.convention(false)
        maxParallel.convention(2)
    }
}
