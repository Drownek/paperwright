package me.drownek.plugwright.api

import org.gradle.api.Named
import org.gradle.api.provider.ListProperty
import org.gradle.api.provider.Property

/**
 * Build-script description of one environment tests can run against.
 *
 * A mode subtypes this with its own fields (`host`, `runDir`, …); everything declared
 * here is owned by plugwright itself and behaves the same for every mode.
 */
interface EnvironmentSpec : Named {

    /** Name used in task names and report files: `local` becomes `plugwrightTestLocal`. */
    override fun getName(): String

    /**
     * Whether `plugwrightTest` includes this environment. Ignored when the per-environment
     * task is invoked directly — an explicit request always runs.
     */
    val includeInMatrix: Property<Boolean>

    /**
     * Whether failures here fail the build when running the matrix. Failures are still
     * reported as failures. Ignored when the per-environment task is invoked directly.
     */
    val allowFailure: Property<Boolean>

    /** Test name substrings to skip in this environment. */
    val excludeTests: ListProperty<String>
}
