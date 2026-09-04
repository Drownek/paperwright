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
 *  accounts on demand, up to [max] connected at once; each one registers on its first login. */
class AutoRegisterSpec(objects: ObjectFactory) {
    /**
     * Must start with `pw_` — generated accounts have to be recognizable as test accounts.
     *
     * The placeholder decides what happens to a name once the test holding it finishes.
     * `%d` (optionally zero-padded, `%04d`) numbers a fixed set of accounts the run keeps coming
     * back to: cheap, but every test inherits whatever the last one left on that account, so
     * anything the stand cannot reset has to stay out of the suite. `%s` puts a random suffix
     * there instead (`pw_%s` → `pw_a8f2`) and never reuses a name, which is the only way a test
     * gets an account with no history — at the cost of a registration the server keeps after the
     * run, so a stand on this shape needs its own way to prune old test accounts.
     */
    val usernamePattern: Property<String> = objects.property(String::class.java).convention("pw_%04d")
    val password: Property<SecretRef> = objects.property(SecretRef::class.java)

    /** How many generated accounts can be connected at the same time. With `%d` it is also the
     *  total number of accounts that will ever exist; with `%s` the run keeps making new ones. */
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
