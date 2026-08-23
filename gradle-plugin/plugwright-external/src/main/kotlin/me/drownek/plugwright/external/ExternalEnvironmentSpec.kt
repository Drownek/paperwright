package me.drownek.plugwright.external

import me.drownek.plugwright.api.EnvironmentSpec
import org.gradle.api.model.ObjectFactory
import org.gradle.api.provider.ListProperty
import org.gradle.api.provider.Property

/**
 * Build-script description of an already-running server: bots connect to [host]:[port]
 * instead of anything this mode spawns, patches or owns. Deploying the plugin under test onto
 * that server is left to the user — this mode assumes it's already installed.
 */
class ExternalEnvironmentSpec(private val environmentName: String, private val objects: ObjectFactory) : EnvironmentSpec {

    override fun getName(): String = environmentName

    // Opt-in, unlike local's opt-out default: a shared external stand shouldn't join every
    // local `plugwrightTest` run unasked.
    override val includeInMatrix: Property<Boolean> = objects.property(Boolean::class.java).convention(false)
    override val allowFailure: Property<Boolean> = objects.property(Boolean::class.java).convention(false)
    override val excludeTests: ListProperty<String> = objects.listProperty(String::class.java).convention(emptyList())

    val host: Property<String> = objects.property(String::class.java)
    val port: Property<Int> = objects.property(Int::class.java).convention(25565)

    /** Mandatory: a proxy in front of the stand (ViaVersion and similar) defeats automatic
     *  protocol version detection, so this can't default to "whatever the server reports". */
    val minecraftVersion: Property<String> = objects.property(String::class.java)

    /** Minimum delay between two bot connects, to stay under anti-bot heuristics on a shared
     *  public server. Zero means "connect as fast as possible", same as today. */
    val joinThrottleMs: Property<Long> = objects.property(Long::class.java).convention(0L)

    internal var consoleSpec: ConsoleSpec? = null
    internal val accountsSpec: AccountsSpec = AccountsSpec(objects)
    internal val pluginsSpec: PluginsSpec = PluginsSpec()

    /** `console { rcon { ... }; adminBot("Name") { ... } }`. */
    fun console(action: ConsoleSpec.() -> Unit) {
        consoleSpec = ConsoleSpec(objects).apply(action)
    }

    /** `accounts { pool { ... }; autoRegister { ... }; microsoft { ... } }`. */
    fun accounts(action: AccountsSpec.() -> Unit) {
        accountsSpec.action()
    }

    /** `plugins { npm(...); local(...) }`. */
    fun plugins(action: PluginsSpec.() -> Unit) {
        pluginsSpec.action()
    }
}
