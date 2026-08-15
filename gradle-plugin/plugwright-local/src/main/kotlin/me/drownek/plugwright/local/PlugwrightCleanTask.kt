package me.drownek.plugwright.local

import org.gradle.api.DefaultTask
import org.gradle.api.file.DirectoryProperty
import org.gradle.api.provider.ListProperty
import org.gradle.api.tasks.Input
import org.gradle.api.tasks.Internal
import org.gradle.api.tasks.TaskAction

/** Wipes the local run directory for a clean slate, keeping whatever [cleanExcludePatterns] names. */
abstract class PlugwrightCleanTask : DefaultTask() {

    @get:Internal
    abstract val runDir: DirectoryProperty

    @get:Input
    abstract val cleanExcludePatterns: ListProperty<String>

    init {
        group = "verification"
        description = "Wipes the test server data for a clean slate."
    }

    @TaskAction
    fun clean() {
        val dir = runDir.get().asFile
        val excludePatterns = cleanExcludePatterns.get()

        if (!dir.exists()) {
            logger.lifecycle("  Run directory doesn't exist yet, nothing to clean")
            return
        }

        logger.lifecycle("  Cleaning run directory (excluding: ${excludePatterns.joinToString(", ")})")

        val allEntries = dir.listFiles() ?: emptyArray()
        val deletedFiles = mutableListOf<String>()
        val keptFiles = mutableListOf<String>()

        allEntries.forEach { entry ->
            val shouldExclude = excludePatterns.any { pattern -> entry.name == pattern }
            if (!shouldExclude) {
                deletedFiles.add(entry.name)
                project.delete(entry)
            } else {
                keptFiles.add(entry.name)
            }
        }

        if (deletedFiles.isNotEmpty()) {
            logger.lifecycle("    deleted:   ${deletedFiles.joinToString(", ")}")
        }
        if (keptFiles.isNotEmpty()) {
            logger.lifecycle("    preserved: ${keptFiles.joinToString(", ")}")
        }
    }
}
