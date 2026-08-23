package me.drownek.plugwright

import com.google.gson.GsonBuilder
import com.google.gson.JsonArray
import com.google.gson.JsonElement
import com.google.gson.JsonNull
import com.google.gson.JsonObject
import com.google.gson.JsonPrimitive
import me.drownek.plugwright.api.ConfigNode
import me.drownek.plugwright.api.ConfigValue
import me.drownek.plugwright.api.SecretRef
import java.io.File

/**
 * Renders the runner configuration file passed to the CLI as `--config`.
 *
 * Secrets are written as references, never as values: the file lands in `build/` and
 * would otherwise leak passwords into build artifacts.
 */
object RunnerConfigWriter {

    /** Bumped when the file layout changes in a way the runner must notice. */
    const val CONFIG_VERSION: Int = 1

    private val gson = GsonBuilder()
        .setPrettyPrinting()
        .disableHtmlEscaping()
        .serializeNulls()
        .create()

    fun write(destination: File, root: ConfigNode): File {
        destination.parentFile?.mkdirs()
        destination.writeText(gson.toJson(toJson(root)), Charsets.UTF_8)
        return destination
    }

    fun toJson(value: ConfigValue): JsonElement = when (value) {
        is ConfigValue.Str -> JsonPrimitive(value.value)
        is ConfigValue.Num -> JsonPrimitive(value.value)
        is ConfigValue.Bool -> JsonPrimitive(value.value)
        is ConfigValue.Secret -> toJson(value.ref)
        is ConfigValue.Arr -> JsonArray().apply { value.values.forEach { add(toJson(it)) } }
        is ConfigValue.Obj -> JsonObject().apply { value.entries.forEach { (k, v) -> add(k, toJson(v)) } }
        ConfigValue.Null -> JsonNull.INSTANCE
    }

    private fun toJson(ref: SecretRef): JsonObject = JsonObject().apply {
        when (ref) {
            is SecretRef.FromEnv -> {
                addProperty("from", "env")
                addProperty("name", ref.name)
            }
            is SecretRef.FromFile -> {
                addProperty("from", "file")
                addProperty("path", ref.path)
            }
            is SecretRef.FromSystemProperty -> {
                addProperty("from", "systemProperty")
                addProperty("name", ref.name)
            }
        }
    }
}
