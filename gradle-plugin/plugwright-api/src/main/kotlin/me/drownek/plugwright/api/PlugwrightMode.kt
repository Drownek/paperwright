package me.drownek.plugwright.api

import org.gradle.api.model.ObjectFactory

/**
 * How one kind of environment is declared in the build script and prepared for a test run.
 *
 * Implementations are stateless singletons: everything configurable lives in the spec, and
 * everything executed lives in the tasks registered by [registerTasks].
 */
interface PlugwrightMode<S : EnvironmentSpec> {

    /** Stable id, written into the runner config: `local`, `external`, `velocity`. */
    val id: String

    /** Spec type this mode creates; also the key the environment container registers a factory under. */
    val specType: Class<S>

    /** Contract version this mode was compiled against. See [PlugwrightApi.VERSION]. */
    val apiVersion: Int get() = PlugwrightApi.VERSION

    /** Creates an empty spec. Use [ObjectFactory.newInstance] so Gradle manages the properties. */
    fun createSpec(name: String, objects: ObjectFactory): S

    /** npm packages the runner needs for this configuration. */
    fun runnerPackages(spec: S): List<RunnerPackageRef> = emptyList()

    /** Configuration-time checks. Report problems through [ValidationContext], do not throw. */
    fun validate(spec: S, ctx: ValidationContext) {}

    /**
     * Seeds [spec] from the deprecated flat extension properties, for a build with no
     * `environments { }` block. No-op for modes with no legacy shape to migrate from.
     */
    fun applyLegacyDefaults(spec: S, legacy: LegacyEnvironmentProperties) {}

    /**
     * Fills in whatever [spec] leaves unset that follows from the workspace layout, before
     * validation and [registerTasks] run. The local mode places its server this way, so a
     * build script that never mentions `runDir` still gets one, under
     * `<workspace>/generated/<environment>`.
     *
     * Only set properties the build script did not: an explicit value always wins.
     */
    fun applyLayoutDefaults(spec: S, layout: PlugwrightLayout) {}

    /**
     * Writes the mode-specific part of the runner config, landing under
     * `environment.config`. Runs at configuration time, so secrets stay [SecretRef]s.
     */
    fun serialize(spec: S, node: ConfigNodeBuilder)

    /** Registers the tasks for this environment: provisioning, mode-specific extras. */
    fun registerTasks(spec: S, ctx: TaskRegistrationContext) {}
}
