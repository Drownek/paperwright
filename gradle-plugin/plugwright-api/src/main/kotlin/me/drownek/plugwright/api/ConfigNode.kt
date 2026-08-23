package me.drownek.plugwright.api

import java.io.Serializable

/**
 * A JSON-shaped value in the runner configuration.
 *
 * Modes build these instead of writing JSON directly: it keeps the api module free of a
 * JSON library, and it lets core render [Secret] entries as references rather than values.
 */
sealed class ConfigValue : Serializable {
    data class Str(val value: String) : ConfigValue()
    data class Num(val value: Number) : ConfigValue()
    data class Bool(val value: Boolean) : ConfigValue()
    data class Secret(val ref: SecretRef) : ConfigValue()
    data class Arr(val values: List<ConfigValue>) : ConfigValue()
    data class Obj(val entries: Map<String, ConfigValue>) : ConfigValue()
    object Null : ConfigValue() {
        private fun readResolve(): Any = Null
    }

    companion object {
        private const val serialVersionUID: Long = 1L
    }
}

/** The object a mode serializes its spec into. */
typealias ConfigNode = ConfigValue.Obj

/**
 * Builder handed to [PlugwrightMode.serialize].
 *
 * Keys are written in insertion order so a regenerated config file stays diff-friendly.
 */
class ConfigNodeBuilder {
    private val entries = LinkedHashMap<String, ConfigValue>()

    fun put(key: String, value: String) = apply { entries[key] = ConfigValue.Str(value) }
    fun put(key: String, value: Number) = apply { entries[key] = ConfigValue.Num(value) }
    fun put(key: String, value: Boolean) = apply { entries[key] = ConfigValue.Bool(value) }
    fun put(key: String, value: SecretRef) = apply { entries[key] = ConfigValue.Secret(value) }
    fun put(key: String, value: ConfigValue) = apply { entries[key] = value }
    fun putNull(key: String) = apply { entries[key] = ConfigValue.Null }

    /** Omits the key entirely when [value] is null — absent and null mean different things downstream. */
    fun putIfPresent(key: String, value: String?) = apply { if (value != null) put(key, value) }

    fun putStrings(key: String, values: Iterable<String>) = apply {
        entries[key] = ConfigValue.Arr(values.map { ConfigValue.Str(it) })
    }

    fun obj(key: String, action: ConfigNodeBuilder.() -> Unit) = apply {
        entries[key] = ConfigNodeBuilder().apply(action).build()
    }

    fun array(key: String, action: ConfigArrayBuilder.() -> Unit) = apply {
        entries[key] = ConfigValue.Arr(ConfigArrayBuilder().apply(action).build())
    }

    fun build(): ConfigNode = ConfigValue.Obj(LinkedHashMap(entries))
}

class ConfigArrayBuilder {
    private val values = mutableListOf<ConfigValue>()

    fun add(value: String) = apply { values.add(ConfigValue.Str(value)) }
    fun add(value: Number) = apply { values.add(ConfigValue.Num(value)) }
    fun add(value: Boolean) = apply { values.add(ConfigValue.Bool(value)) }
    fun add(value: ConfigValue) = apply { values.add(value) }

    fun obj(action: ConfigNodeBuilder.() -> Unit) = apply {
        values.add(ConfigNodeBuilder().apply(action).build())
    }

    fun build(): List<ConfigValue> = values.toList()
}
