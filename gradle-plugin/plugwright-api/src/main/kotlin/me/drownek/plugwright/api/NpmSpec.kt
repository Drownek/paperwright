package me.drownek.plugwright.api

import java.io.Serializable

/**
 * Credentials for one registry, as pointers to secrets — never the values.
 *
 * The values are read when the `.npmrc` is written, during task execution. Reading them
 * while the build script is being configured would put them into the configuration cache.
 */
data class NpmCredentials(
    val authToken: SecretRef? = null,
    val username: SecretRef? = null,
    val password: SecretRef? = null
) : Serializable {

    val isEmpty: Boolean get() = authToken == null && username == null && password == null

    companion object {
        private const val serialVersionUID: Long = 1L

        val NONE = NpmCredentials()
    }
}

/**
 * A registry npm should fetch from: the default one, or the one a single scope resolves to.
 *
 * @param scope npm scope including the leading `@`, e.g. `@plugwright`; null for the default registry
 * @param url registry URL, e.g. `https://nexus.corp/repository/npm-private/`
 */
data class NpmRegistry(
    val scope: String?,
    val url: String,
    val credentials: NpmCredentials = NpmCredentials.NONE
) : Serializable {
    companion object {
        private const val serialVersionUID: Long = 1L
    }
}

/**
 * What the workspace's generated `.npmrc` should say: which registries to fetch from, how to
 * authenticate against them, and any other npm option the build script sets.
 *
 * Built from the `npm { }` block ([NpmSpec]) and carried into the tasks that run `npm install`.
 */
data class NpmConfig(
    val registries: List<NpmRegistry> = emptyList(),
    val options: Map<String, String> = emptyMap()
) : Serializable {

    /** No `npm { }` block, or an empty one: nothing to generate, and no `.npmrc` to keep. */
    val isEmpty: Boolean get() = registries.isEmpty() && options.isEmpty()

    /**
     * Configuration mistakes worth failing the build over, reported before anything runs
     * `npm install` — npm answers a malformed registry line with a 404 against the public
     * registry, which is a much longer way round to the same conclusion.
     */
    fun problems(): List<String> {
        val problems = mutableListOf<String>()

        registries.forEach { registry ->
            val label = registry.scope?.let { "scope '$it'" } ?: "the default registry"

            if (registry.scope != null && !registry.scope.startsWith("@")) {
                problems += "npm scope '${registry.scope}' must start with '@'"
            }
            if (!registry.url.startsWith("http://") && !registry.url.startsWith("https://")) {
                problems += "registry URL for $label must start with http:// or https://, got '${registry.url}'"
            }

            val credentials = registry.credentials
            if (credentials.username != null && credentials.password == null) {
                problems += "$label has a username but no password"
            }
            if (credentials.password != null && credentials.username == null) {
                problems += "$label has a password but no username"
            }
        }

        val duplicateScopes = registries.groupBy { it.scope }.filterValues { it.size > 1 }.keys
        duplicateScopes.forEach { scope ->
            problems += scope?.let { "npm scope '$it' is declared more than once" }
                ?: "the default npm registry is declared more than once"
        }

        options.keys.filter { it.isBlank() }.forEach { _ ->
            problems += "npm option keys cannot be blank"
        }

        return problems
    }

    companion object {
        private const val serialVersionUID: Long = 1L

        val EMPTY = NpmConfig()
    }
}

/**
 * Credentials for one registry, as a build-script block.
 *
 * Only [SecretRef]s: a literal token in a build script ends up in the configuration cache,
 * in build scans, and — for anyone who forgets what a build script is — in version control.
 * Use `secret.env("NPM_TOKEN")`, which is also what a CI job already has.
 */
class NpmCredentialsSpec {
    private var authToken: SecretRef? = null
    private var username: SecretRef? = null
    private var password: SecretRef? = null

    /** Bearer token for this registry, written as `_authToken`. */
    fun authToken(ref: SecretRef) {
        authToken = ref
    }

    /** Basic-auth user, written as `username`; needs a [password]. */
    fun username(ref: SecretRef) {
        username = ref
    }

    /** Basic-auth password, written base64-encoded as `_password`; needs a [username]. */
    fun password(ref: SecretRef) {
        password = ref
    }

    internal fun build(): NpmCredentials = NpmCredentials(authToken, username, password)
}

/**
 * The `npm { }` block: which registries this workspace installs from.
 *
 * ```kotlin
 * plugwright {
 *     npm {
 *         registry("https://nexus.corp/repository/npm-group/") {
 *             authToken(secret.env("NPM_TOKEN"))
 *         }
 *         scope("@plugwright", "https://nexus.corp/repository/npm-private/") {
 *             username(secret.env("NPM_USER"))
 *             password(secret.env("NPM_PASS"))
 *         }
 *         option("strict-ssl", "false")
 *     }
 * }
 * ```
 *
 * The block becomes a `.npmrc` in the workspace root, written just before each `npm install`
 * the build runs. It covers the whole workspace rather than one environment: there is one
 * `node_modules` and one install for the entire matrix.
 */
class NpmSpec {
    private val registries = mutableListOf<NpmRegistry>()
    private val options = linkedMapOf<String, String>()

    /** The registry every package comes from unless a scope says otherwise. */
    @JvmOverloads
    fun registry(url: String, action: NpmCredentialsSpec.() -> Unit = {}) {
        registries += NpmRegistry(null, url, NpmCredentialsSpec().apply(action).build())
    }

    /** The registry packages under [scope] (`@plugwright`, leading `@` included) come from. */
    @JvmOverloads
    fun scope(scope: String, url: String, action: NpmCredentialsSpec.() -> Unit = {}) {
        registries += NpmRegistry(scope, url, NpmCredentialsSpec().apply(action).build())
    }

    /**
     * Any other npm setting, written verbatim: `option("strict-ssl", "false")`,
     * `option("cafile", "/etc/ssl/corp-ca.pem")`.
     */
    fun option(key: String, value: String) {
        options[key] = value
    }

    /** Snapshot of the block, for the tasks that write the `.npmrc`. */
    fun toConfig(): NpmConfig = NpmConfig(registries.toList(), options.toMap())
}
