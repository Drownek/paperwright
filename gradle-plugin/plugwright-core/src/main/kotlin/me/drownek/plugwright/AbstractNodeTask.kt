package me.drownek.plugwright

import org.gradle.api.DefaultTask
import org.gradle.api.file.DirectoryProperty
import org.gradle.api.provider.Property
import org.gradle.api.tasks.Input
import org.gradle.api.tasks.Internal
import java.io.File

/**
 * Base for tasks that shell out to Node.js or to the test server.
 *
 * Holds the Node.js resolution inputs and the process plumbing; knows nothing about
 * server provisioning.
 */
abstract class AbstractNodeTask : DefaultTask() {

    @get:Input
    abstract val nodeVersion: Property<String>

    @get:Input
    abstract val downloadNode: Property<Boolean>

    @get:Internal
    abstract val nodeInstallDir: DirectoryProperty

    protected fun resolveNode(): NodeManager.NodePaths =
        NodeManager.getOrDownloadNode(nodeInstallDir.get().asFile, nodeVersion.get(), downloadNode.get())

    /** Environment that puts the resolved Node.js on PATH for child processes. */
    protected fun nodePathEnv(nodePaths: NodeManager.NodePaths): Map<String, String> {
        val nodeDir = File(nodePaths.node).parent ?: return emptyMap()
        val pathKey = System.getenv().keys.firstOrNull { it.equals("PATH", ignoreCase = true) } ?: "PATH"
        return mapOf(pathKey to nodeDir + File.pathSeparator + (System.getenv(pathKey) ?: ""))
    }

    protected fun runCommand(
        dir: File,
        vararg command: String,
        env: Map<String, String> = emptyMap(),
        interactive: Boolean = false,
        onStdoutLine: ((String) -> Unit)? = null
    ) {
        val isWindows = System.getProperty("os.name").lowercase().contains("win")
        val cmdName = File(command[0]).nameWithoutExtension.lowercase()
        val cmd = if (isWindows && (cmdName == "npm" || cmdName == "node")) {
            listOf("cmd", "/c") + command
        } else {
            command.toList()
        }

        val processBuilder = ProcessBuilder(cmd)
        processBuilder.directory(dir)
        processBuilder.environment().putAll(env)

        val process = processBuilder.start()

        val shutdownHook = Thread {
            if (process.isAlive) killProcessTree(process)
        }
        Runtime.getRuntime().addShutdownHook(shutdownHook)
        try {
            runProcess(process, command, interactive, onStdoutLine)
        } finally {
            try {
                Runtime.getRuntime().removeShutdownHook(shutdownHook)
            } catch (_: IllegalStateException) {}
        }
    }

    protected fun runProcess(
        process: Process,
        command: Array<out String>,
        interactive: Boolean = false,
        onStdoutLine: ((String) -> Unit)? = null
    ) {
        val stdoutThread = Thread {
            process.inputStream.bufferedReader(Charsets.UTF_8).useLines { lines ->
                lines.forEach { line ->
                    logger.lifecycle(line)
                    onStdoutLine?.invoke(line)
                }
            }
        }
        stdoutThread.isDaemon = true

        val stderrThread = Thread {
            process.errorStream.bufferedReader(Charsets.UTF_8).useLines { lines ->
                lines.forEach { logger.error(it) }
            }
        }
        stderrThread.isDaemon = true

        var stdinThread: Thread? = null
        if (interactive) {
            stdinThread = Thread {
                try {
                    val reader = System.`in`.bufferedReader(Charsets.UTF_8)
                    val out = process.outputStream
                    while (true) {
                        val line = reader.readLine() ?: break
                        out.write((line + "\n").toByteArray(Charsets.UTF_8))
                        out.flush()
                    }
                } catch (_: Exception) {}
            }
            stdinThread.isDaemon = true
            stdinThread.start()
        }

        stdoutThread.start()
        stderrThread.start()

        val exitCode = try {
            process.waitFor()
        } catch (e: InterruptedException) {
            logger.lifecycle("[E2E] Build cancelled, gracefully terminating server process tree...")

            killProcessTree(process)

            // Re-interrupt the thread after doing the cleanup
            Thread.currentThread().interrupt()
            throw RuntimeException("E2E build cancelled; spawned server was terminated.", e)
        }

        try { stdoutThread.join(2000) } catch (_: InterruptedException) {}
        try { stderrThread.join(2000) } catch (_: InterruptedException) {}

        if (exitCode != 0) {
            throw RuntimeException("Command '${command.joinToString(" ")}' failed with exit code: $exitCode")
        }
    }

    protected fun killProcessTree(process: Process) {
        try {
            val isJava = process.info().command().orElse("")?.contains("java") ?: false
            if (isJava) {
                try {
                    val out = process.outputStream
                    out.write("stop\n".toByteArray())
                    out.flush()
                } catch (_: Exception) {}
                process.waitFor(3, java.util.concurrent.TimeUnit.SECONDS)
            }

            val handle = process.toHandle()
            val descendants = handle.descendants().toList()

            // Kill parent first to prevent respawning
            handle.destroyForcibly()
            process.waitFor(2, java.util.concurrent.TimeUnit.SECONDS)

            // Then kill descendants
            descendants.forEach {
                try { it.destroyForcibly() } catch (_: Throwable) {}
            }

        } catch (_: Throwable) {
            // best effort
        }
    }
}
