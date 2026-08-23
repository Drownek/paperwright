package me.drownek.plugwright.api

import java.io.File
import java.io.Serializable

/**
 * One file to write into an environment's run directory before the server starts.
 * Exactly one of [content] or [sourceFile] is non-null.
 */
data class RunDirFile(
    val path: String,
    val content: String?,
    val sourceFile: File?
) : Serializable {
    companion object {
        private const val serialVersionUID: Long = 1L
    }
}
