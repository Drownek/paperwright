package me.drownek.plugwright.external

import me.drownek.plugwright.api.SecretRef
import org.gradle.api.model.ObjectFactory
import org.gradle.api.provider.Property

/** One console channel a build script can declare. Channels are probed in declaration order
 *  at runtime; the first one that connects becomes the session's console. */
sealed class ConsoleChannelSpec {

    /** `console { rcon { port.set(25575); password.set(secret.env("RCON_PASS")) } }`. Needs the
     *  separate `@plugwright/console-rcon` runner package. */
    class Rcon(objects: ObjectFactory) : ConsoleChannelSpec() {
        val port: Property<Int> = objects.property(Int::class.java).convention(25575)
        val password: Property<SecretRef> = objects.property(SecretRef::class.java)
    }

    /** `console { adminBot("StaffBot") { password.set(secret.env("STAFF_PASS")) } }`. A second
     *  mineflayer bot with staff rights, sending commands through chat. */
    class AdminBot(val username: String, objects: ObjectFactory) : ConsoleChannelSpec() {
        val password: Property<SecretRef> = objects.property(SecretRef::class.java)
    }
}

/**
 * `console { rcon { ... }; adminBot("Name") { ... } }`.
 *
 * Declaring neither channel is valid — the environment just runs without a console, and any
 * test requiring one is skipped and reported as such.
 */
class ConsoleSpec(private val objects: ObjectFactory) {
    internal val channels = mutableListOf<ConsoleChannelSpec>()

    fun rcon(action: ConsoleChannelSpec.Rcon.() -> Unit) {
        channels.add(ConsoleChannelSpec.Rcon(objects).apply(action))
    }

    fun adminBot(username: String, action: ConsoleChannelSpec.AdminBot.() -> Unit) {
        channels.add(ConsoleChannelSpec.AdminBot(username, objects).apply(action))
    }
}
