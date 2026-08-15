package me.drownek.plugwright.external

import me.drownek.plugwright.api.SecretRef
import org.gradle.api.file.DirectoryProperty
import org.gradle.api.model.ObjectFactory
import org.gradle.api.provider.Property

/** One named account in the fixed `pool`. */
class PoolAccountSpec(val username: String, objects: ObjectFactory) {
    val password: Property<SecretRef> = objects.property(SecretRef::class.java)
}

/** `pool { account("TestBot1") { password.set(...) } }`. */
class PoolSpec(private val objects: ObjectFactory) {
    internal val accounts = mutableListOf<PoolAccountSpec>()

    fun account(username: String, action: PoolAccountSpec.() -> Unit) {
        accounts.add(PoolAccountSpec(username, objects).apply(action))
    }
}

/** `autoRegister { usernamePattern.set("pw_%04d"); password.set(...); max.set(4) }`. Generates
 *  fresh accounts on demand, up to [max] at once; each one registers on its first login. */
class AutoRegisterSpec(objects: ObjectFactory) {
    /** Must start with `pw_` — generated accounts have to be recognizable as test accounts,
     *  the same convention the cleanup journal requires of entities it creates. */
    val usernamePattern: Property<String> = objects.property(String::class.java).convention("pw_%04d")
    val password: Property<SecretRef> = objects.property(SecretRef::class.java)
    val max: Property<Int> = objects.property(Int::class.java).convention(4)
}

/** `microsoft { account("bot@example.com"); cacheDir.set(...) }`. Online-mode accounts;
 *  no password — mineflayer authenticates through a cached Microsoft token. */
class MicrosoftAccountsSpec(objects: ObjectFactory) {
    internal val accountNames = mutableListOf<String>()
    val cacheDir: DirectoryProperty = objects.directoryProperty()

    fun account(usernameOrEmail: String) {
        accountNames.add(usernameOrEmail)
    }
}

/** `accounts { pool { ... }; autoRegister { ... }; microsoft { ... } }` — the three sources an
 *  account pool merges at runtime. All three are optional and independent. */
class AccountsSpec(private val objects: ObjectFactory) {
    internal var pool: PoolSpec? = null
    internal var autoRegister: AutoRegisterSpec? = null
    internal var microsoft: MicrosoftAccountsSpec? = null

    fun pool(action: PoolSpec.() -> Unit) {
        pool = PoolSpec(objects).apply(action)
    }

    fun autoRegister(action: AutoRegisterSpec.() -> Unit) {
        autoRegister = AutoRegisterSpec(objects).apply(action)
    }

    fun microsoft(action: MicrosoftAccountsSpec.() -> Unit) {
        microsoft = MicrosoftAccountsSpec(objects).apply(action)
    }
}
