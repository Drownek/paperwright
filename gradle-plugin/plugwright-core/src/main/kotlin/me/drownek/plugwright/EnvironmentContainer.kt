package me.drownek.plugwright

import me.drownek.plugwright.api.EnvironmentSpec
import me.drownek.plugwright.api.PlugwrightMode
import org.gradle.api.GradleException
import org.gradle.api.model.ObjectFactory

/**
 * Registry of [PlugwrightMode]s and the [EnvironmentSpec]s declared against them.
 *
 * A hand-rolled container rather than Gradle's `ExtensiblePolymorphicDomainObjectContainer`:
 * environments are created once while the build script is evaluated and read back once in
 * `afterEvaluate`, so the extra machinery of a live domain object container buys nothing here.
 */
class EnvironmentContainer(private val objects: ObjectFactory) {

    class Entry(val spec: EnvironmentSpec, val mode: PlugwrightMode<*>)

    private val modesById = mutableMapOf<String, PlugwrightMode<*>>()
    private val entries = linkedMapOf<String, Entry>()

    fun registerMode(mode: PlugwrightMode<*>) {
        modesById[mode.id] = mode
    }

    fun modeById(id: String): PlugwrightMode<*> =
        modesById[id] ?: throw GradleException(
            "No plugwright mode is registered under id '$id'. Call registerMode(...) first " +
                "(the built-in local mode registers itself when the plugin is applied)."
        )

    /** Declares environment [name], backed by [mode]'s spec type. */
    fun <S : EnvironmentSpec> create(name: String, mode: PlugwrightMode<S>, action: S.() -> Unit = {}): S {
        if (entries.containsKey(name)) {
            throw GradleException("Environment '$name' is already declared.")
        }
        val spec = mode.createSpec(name, objects)
        spec.action()
        entries[name] = Entry(spec, mode)
        return spec
    }

    /**
     * Creates environment [name] from whatever mode is registered under that same id, with no
     * build-script configuration. Used for the implicit "local" environment.
     */
    fun createImplicit(name: String): Entry {
        create(name, modeById(name).erased()) {}
        return entries.getValue(name)
    }

    val isEmpty: Boolean get() = entries.isEmpty()
    val names: Set<String> get() = entries.keys
    val all: Collection<Entry> get() = entries.values
    operator fun get(name: String): Entry? = entries[name]
}

/**
 * Recovers usable static typing after a [PlugwrightMode] has been erased to `PlugwrightMode<*>`.
 * Safe because the [EnvironmentSpec] passed alongside it always came from that same mode's
 * [PlugwrightMode.createSpec].
 */
@Suppress("UNCHECKED_CAST")
internal fun PlugwrightMode<*>.erased(): PlugwrightMode<EnvironmentSpec> = this as PlugwrightMode<EnvironmentSpec>
