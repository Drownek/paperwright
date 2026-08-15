package me.drownek.plugwright

import me.drownek.plugwright.api.ValidationContext
import org.gradle.api.logging.Logger

/** Warnings are logged immediately; errors are collected so the plugin can report every
 *  environment's problems in one build failure instead of stopping at the first one. */
internal class ValidationContextImpl(
    override val environmentName: String,
    private val logger: Logger
) : ValidationContext {

    val errors = mutableListOf<String>()

    override fun error(message: String) {
        errors.add(message)
    }

    override fun warn(message: String) {
        logger.warn("plugwright [$environmentName]: $message")
    }
}
