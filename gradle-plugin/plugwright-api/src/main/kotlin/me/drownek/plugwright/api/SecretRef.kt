package me.drownek.plugwright.api

import org.gradle.api.Project
import java.io.File
import java.io.Serializable

/**
 * A pointer to a secret value, never the value itself.
 *
 * Secrets are resolved by the runner at execution time. Resolving them during the
 * configuration phase would put passwords into the configuration cache and into
 * build artifacts.
 */
sealed class SecretRef : Serializable {

    /** Read the secret from the environment variable [name]. */
    data class FromEnv(val name: String) : SecretRef()

    /** Read the secret from the first line of [path]. */
    data class FromFile(val path: String) : SecretRef() {
        constructor(file: File) : this(file.absolutePath)
    }

    /** Read the secret from the system property [name]. */
    data class FromSystemProperty(val name: String) : SecretRef()

    companion object {
        private const val serialVersionUID: Long = 1L
    }
}

/**
 * Factory for [SecretRef] values, exposed to build scripts as `secret`.
 */
object Secrets {
    fun env(name: String): SecretRef = SecretRef.FromEnv(name)
    fun file(path: String): SecretRef = SecretRef.FromFile(path)
    fun file(file: File): SecretRef = SecretRef.FromFile(file)
    fun systemProperty(name: String): SecretRef = SecretRef.FromSystemProperty(name)
}

/** `secret.env("X")` / `secret.file(path)` in a build script, anywhere the implicit `Project`
 *  receiver is reachable — including nested `environments { create(...) { ... } }` blocks. */
val Project.secret: Secrets get() = Secrets
