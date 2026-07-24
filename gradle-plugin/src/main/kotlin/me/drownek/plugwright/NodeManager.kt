package me.drownek.plugwright

import org.gradle.api.GradleException
import org.gradle.api.logging.Logger
import org.gradle.api.logging.Logging
import java.io.File
import java.io.RandomAccessFile
import java.net.URI
import java.net.http.HttpClient
import java.net.http.HttpRequest
import java.net.http.HttpResponse
import java.nio.file.Files
import java.nio.file.StandardCopyOption
import java.security.MessageDigest
import java.time.Duration
import java.util.zip.ZipFile

object NodeManager {

    private val logger: Logger = Logging.getLogger(NodeManager::class.java)

    private val DOWNLOAD_TIMEOUT: Duration = Duration.ofMinutes(10)

    data class NodePaths(val node: String, val npm: String)

    private fun checkSystemNodeAvailable(isWindows: Boolean) {
        val command = if (isWindows) listOf("cmd", "/c", "node", "--version") else listOf("node", "--version")
        val available = try {
            val process = ProcessBuilder(command).redirectErrorStream(true).start()
            process.inputStream.bufferedReader().readText()
            process.waitFor() == 0
        } catch (e: Exception) {
            false
        }
        if (!available) {
            throw GradleException(
                "Node.js not found on PATH. Install Node.js (https://nodejs.org), " +
                    "or set 'plugwright { downloadNode.set(true) }' to let the plugin download it automatically."
            )
        }
    }

    fun getOrDownloadNode(nodeInstallDir: File, nodeVersionOpt: String, downloadNodeOpt: Boolean): NodePaths {
        if (!downloadNodeOpt) {
            val isWindows = System.getProperty("os.name").lowercase().contains("win")
            checkSystemNodeAvailable(isWindows)
            return NodePaths("node", if (isWindows) "npm.cmd" else "npm")
        }

        val nodeVersion = nodeVersionOpt.trim().removePrefix("v")
        val nodeDir = nodeInstallDir
        val osName = System.getProperty("os.name").lowercase()
        val osArch = System.getProperty("os.arch").lowercase()

        val isWindows = osName.contains("win")
        val isLinux = osName.contains("linux")
        val isMac = osName.contains("mac")

        if (isLinux && (File("/etc/alpine-release").exists() || osName.contains("alpine"))) {
            throw GradleException("Alpine Linux (musl) is not supported for automatic Node.js downloading via this plugin. Please set downloadNode=false and use the system Node.js.")
        }
        if (!isWindows && !isLinux && !isMac) {
            throw GradleException("OS '${System.getProperty("os.name")}' is not supported for automatic Node.js downloading. Please set downloadNode=false and use the system Node.js.")
        }

        val os = when {
            isWindows -> "win"
            isMac -> "darwin"
            else -> "linux"
        }

        val arch = when {
            osArch.contains("aarch64") || osArch.contains("arm64") -> "arm64"
            osArch.contains("arm") -> "armv7l"
            (osArch.contains("x86") && !osArch.contains("64")) || osArch == "i386" -> "x86"
            else -> "x64"
        }

        val ext = if (isWindows) "zip" else "tar.gz"
        val folderName = "node-v$nodeVersion-$os-$arch"
        val fileName = "$folderName.$ext"

        val extractDir = File(nodeDir, folderName)

        val nodeExe = if (isWindows) File(extractDir, "node.exe") else File(extractDir, "bin/node")
        val npmExe = if (isWindows) File(extractDir, "npm.cmd") else File(extractDir, "bin/npm")

        val markerFile = File(nodeDir, "$folderName.extracted")

        if (!markerFile.exists()) {
            nodeDir.mkdirs()

            val lockFile = File(nodeDir, "node-download.lock")
            RandomAccessFile(lockFile, "rw").use { raf ->
                val channel = raf.channel
                // Acquire exclusive lock
                val lock = channel.lock()

                try {
                    // Double check after acquiring lock
                    if (!markerFile.exists()) {
                        val downloadUrl = "https://nodejs.org/dist/v$nodeVersion/$fileName"
                        val archiveFile = File(nodeDir, fileName)
                        val tmpArchiveFile = File(nodeDir, "$fileName.tmp")

                        val httpClient = HttpClient.newBuilder()
                            .followRedirects(HttpClient.Redirect.NORMAL)
                            .connectTimeout(Duration.ofSeconds(30))
                            .build()

                        if (!archiveFile.exists()) {
                            logger.lifecycle("Node.js not found locally. Downloading Node.js v$nodeVersion for $os-$arch...")

                            val request = HttpRequest.newBuilder()
                                .uri(URI.create(downloadUrl))
                                .timeout(DOWNLOAD_TIMEOUT)
                                .GET()
                                .build()

                            logger.lifecycle("Downloading from: $downloadUrl")
                            val response = httpClient.send(request, HttpResponse.BodyHandlers.ofInputStream())
                            if (response.statusCode() != 200) {
                                throw GradleException("Failed to download Node.js from $downloadUrl. Status code: ${response.statusCode()}")
                            }

                            Files.copy(response.body(), tmpArchiveFile.toPath(), StandardCopyOption.REPLACE_EXISTING)
                            Files.move(tmpArchiveFile.toPath(), archiveFile.toPath(), StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING)
                            logger.lifecycle("Downloaded Node.js archive.")
                        }

                        verifyChecksum(httpClient, nodeVersion, fileName, archiveFile)

                        logger.lifecycle("Extracting Node.js archive...")
                        if (isWindows) {
                            extractZip(archiveFile, nodeDir)
                        } else {
                            // Use native tar to preserve symlinks (bin/npm and bin/npx are
                            // symlinks into lib/node_modules) and executable permissions.
                            extractTarGz(archiveFile, nodeDir)
                        }

                        if (!nodeExe.exists() || !npmExe.exists()) {
                            throw GradleException("Failed to extract Node.js or unexpected directory structure. Expected to find ${nodeExe.absolutePath} and ${npmExe.absolutePath}")
                        }

                        markerFile.createNewFile()
                    }
                } finally {
                    lock.release()
                }
            }
        }

        return NodePaths(nodeExe.absolutePath, npmExe.absolutePath)
    }

    private fun verifyChecksum(httpClient: HttpClient, nodeVersion: String, fileName: String, archiveFile: File) {
        val shasumsUrl = "https://nodejs.org/dist/v$nodeVersion/SHASUMS256.txt"
        val request = HttpRequest.newBuilder()
            .uri(URI.create(shasumsUrl))
            .timeout(Duration.ofMinutes(1))
            .GET()
            .build()

        val response = httpClient.send(request, HttpResponse.BodyHandlers.ofString())
        if (response.statusCode() != 200) {
            throw GradleException("Failed to download Node.js checksums from $shasumsUrl. Status code: ${response.statusCode()}")
        }

        val expectedChecksum = response.body().lineSequence()
            .map { it.trim().split(Regex("\\s+")) }
            .firstOrNull { it.size >= 2 && it[1] == fileName }
            ?.get(0)
            ?: throw GradleException("No checksum entry for $fileName found in $shasumsUrl")

        val digest = MessageDigest.getInstance("SHA-256")
        archiveFile.inputStream().use { input ->
            val buffer = ByteArray(64 * 1024)
            while (true) {
                val read = input.read(buffer)
                if (read < 0) break
                digest.update(buffer, 0, read)
            }
        }
        val actualChecksum = digest.digest().joinToString("") { "%02x".format(it) }

        if (!actualChecksum.equals(expectedChecksum, ignoreCase = true)) {
            archiveFile.delete()
            throw GradleException("SHA-256 checksum mismatch for $fileName. Expected $expectedChecksum but was $actualChecksum. The corrupted archive was deleted; please re-run the build.")
        }
        logger.lifecycle("Verified Node.js archive checksum (SHA-256).")
    }

    private fun extractTarGz(archiveFile: File, destinationDir: File) {
        val process = ProcessBuilder("tar", "-xzf", archiveFile.absolutePath, "-C", destinationDir.absolutePath)
            .redirectErrorStream(true)
            .start()
        val output = process.inputStream.bufferedReader().readText()
        val exitCode = process.waitFor()
        if (exitCode != 0) {
            throw GradleException("Failed to extract ${archiveFile.name} with tar (exit code $exitCode): $output")
        }
    }

    private fun extractZip(archiveFile: File, destinationDir: File) {
        ZipFile(archiveFile).use { zip ->
            val destPath = destinationDir.canonicalFile.toPath()
            for (entry in zip.entries()) {
                val target = File(destinationDir, entry.name)
                if (!target.canonicalFile.toPath().startsWith(destPath)) {
                    throw GradleException("Refusing to extract zip entry outside of destination directory: ${entry.name}")
                }
                if (entry.isDirectory) {
                    target.mkdirs()
                } else {
                    target.parentFile?.mkdirs()
                    zip.getInputStream(entry).use { input ->
                        Files.copy(input, target.toPath(), StandardCopyOption.REPLACE_EXISTING)
                    }
                }
            }
        }
    }
}
