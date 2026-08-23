package me.drownek.plugwright.local

import com.google.gson.JsonParser
import me.drownek.plugwright.api.RunDirFile
import org.gradle.api.DefaultTask
import org.gradle.api.GradleException
import org.gradle.api.file.DirectoryProperty
import org.gradle.api.provider.ListProperty
import org.gradle.api.provider.Property
import org.gradle.api.tasks.*
import org.yaml.snakeyaml.DumperOptions
import org.yaml.snakeyaml.Yaml
import java.io.File
import java.net.URI
import java.net.http.HttpClient
import java.net.http.HttpRequest
import java.net.http.HttpResponse
import java.nio.file.Files
import java.nio.file.StandardCopyOption
import java.time.Duration

/**
 * Downloads Paper, stages configured files, patches server/bukkit/spigot configs, and
 * installs the plugin under test — everything the local server needs before it can start.
 */
abstract class PaperProvisionTask : DefaultTask() {

    @get:OutputDirectory
    abstract val runDir: DirectoryProperty

    @get:Input
    abstract val minecraftVersion: Property<String>

    @get:Input
    @get:Optional
    abstract val pluginJar: Property<File>

    @get:Input
    abstract val pluginUrls: ListProperty<String>

    @get:Input
    @get:Optional
    abstract val runDirFiles: ListProperty<RunDirFile>

    init {
        group = "verification"
        description = "Downloads Paper and prepares the local test server"
    }

    @TaskAction
    fun provision() {
        val runDirectory = runDir.get().asFile
        if (!runDirectory.exists() && !runDirectory.mkdirs()) {
            throw GradleException("Failed to create run directory at ${runDirectory.absolutePath}")
        }

        // Write staged files into the run directory
        val filesToWrite = if (runDirFiles.isPresent) runDirFiles.get() else emptyList()
        if (filesToWrite.isNotEmpty()) {
            logger.lifecycle("Writing ${filesToWrite.size} staged file(s) to run directory...")
            filesToWrite.forEach { entry ->
                val destination = File(runDirectory, entry.path)
                destination.parentFile?.mkdirs()
                val content = entry.content
                val sourceFile = entry.sourceFile
                when {
                    content != null -> {
                        destination.writeText(content, Charsets.UTF_8)
                        logger.lifecycle("  Wrote: ${entry.path}")
                    }
                    sourceFile != null -> {
                        if (!sourceFile.exists()) {
                            throw GradleException("Staged file source does not exist: ${sourceFile.absolutePath}")
                        }
                        Files.copy(sourceFile.toPath(), destination.toPath(), StandardCopyOption.REPLACE_EXISTING)
                        logger.lifecycle("  Copied: ${sourceFile.name} -> ${entry.path}")
                    }
                }
            }
        }

        // Ensure online-mode=false and connection-throttle=0 in server.properties
        val serverProperties = File(runDirectory, "server.properties")
        if (serverProperties.exists()) {
            var lines = Files.readAllLines(serverProperties.toPath()).toMutableList()

            val hasOnlineMode = lines.any { it.trim().startsWith("online-mode=") }
            if (hasOnlineMode) {
                lines = lines.map { line ->
                    if (line.trim().startsWith("online-mode=")) "online-mode=false" else line
                }.toMutableList()
            } else {
                lines.add("online-mode=false")
            }

            val hasConnectionThrottle = lines.any { it.trim().startsWith("connection-throttle=") }
            if (hasConnectionThrottle) {
                lines = lines.map { line ->
                    if (line.trim().startsWith("connection-throttle=")) "connection-throttle=0" else line
                }.toMutableList()
            } else {
                lines.add("connection-throttle=0")
            }

            // Disable spawn protection so tests can damage players near spawn
            val hasSpawnProtection = lines.any { it.trim().startsWith("spawn-protection=") }
            if (hasSpawnProtection) {
                lines = lines.map { line ->
                    if (line.trim().startsWith("spawn-protection=")) "spawn-protection=0" else line
                }.toMutableList()
            } else {
                lines.add("spawn-protection=0")
            }

            Files.write(serverProperties.toPath(), lines)
        } else {
            logger.lifecycle("Creating server.properties with online-mode=false, connection-throttle=0 and spawn-protection=0")
            Files.write(serverProperties.toPath(), listOf("online-mode=false", "connection-throttle=0", "spawn-protection=0"))
        }

        configureBukkitSettings(runDirectory)
        configureSpigotSettings(runDirectory)

        // Create plugins directory if it doesn't exist
        val pluginsDir = File(runDirectory, "plugins")
        if (!pluginsDir.exists() && !pluginsDir.mkdirs()) {
            throw GradleException("Failed to create plugins directory at ${pluginsDir.absolutePath}")
        }

        // Copy the project plugin to the server
        if (pluginJar.isPresent) {
            val jarFile = pluginJar.get()
            if (jarFile.exists()) {
                logger.lifecycle("Installing plugin: ${jarFile.name}")
                Files.copy(jarFile.toPath(), File(pluginsDir, jarFile.name).toPath(), StandardCopyOption.REPLACE_EXISTING)
            } else {
                throw GradleException("Plugin jar configured but does not exist: $jarFile")
            }
        }

        // Download additional plugins from URLs
        val urls = pluginUrls.get()
        if (urls.isNotEmpty()) {
            logger.lifecycle("Downloading ${urls.size} plugin(s)...")
            val httpClient = HttpClient.newBuilder()
                .followRedirects(HttpClient.Redirect.NORMAL)
                .connectTimeout(Duration.ofSeconds(30))
                .build()
            urls.forEach { url ->
                downloadPlugin(httpClient, url, pluginsDir)
            }
        }

        // Download Paper server if needed
        val serverJarFile = File(runDirectory, "server.jar")
        if (!serverJarFile.exists()) {
            logger.lifecycle("Server JAR not found. Downloading Paper server for Minecraft ${minecraftVersion.get()}...")
            downloadPaperServer(minecraftVersion.get(), serverJarFile)
        }
    }

    private fun downloadPaperServer(version: String, destination: File) {
        val httpClient = HttpClient.newBuilder().build()

        try {
            logger.lifecycle("Fetching latest Paper build for Minecraft $version...")

            val versionInfoUrl = "https://fill.papermc.io/v3/projects/paper/versions/$version"
            val versionRequest = HttpRequest.newBuilder()
                .uri(URI.create(versionInfoUrl))
                .GET()
                .build()

            val versionResponse = httpClient.send(versionRequest, HttpResponse.BodyHandlers.ofString())

            if (versionResponse.statusCode() != 200) {
                throw GradleException("Failed to fetch Paper version info. Status: ${versionResponse.statusCode()}. Make sure Minecraft version '$version' is valid.")
            }

            val versionJson = JsonParser.parseString(versionResponse.body()).asJsonObject
            val buildsArray = versionJson.getAsJsonArray("builds")

            if (buildsArray.size() == 0) {
                throw GradleException("No builds found for Minecraft version $version")
            }

            val latestBuild = buildsArray.last().asInt
            logger.lifecycle("Found latest build: $latestBuild")

            val buildInfoUrl = "https://fill.papermc.io/v3/projects/paper/versions/$version/builds/$latestBuild"
            val buildRequest = HttpRequest.newBuilder()
                .uri(URI.create(buildInfoUrl))
                .GET()
                .build()

            val buildResponse = httpClient.send(buildRequest, HttpResponse.BodyHandlers.ofString())

            if (buildResponse.statusCode() != 200) {
                throw GradleException("Failed to fetch build info. Status: ${buildResponse.statusCode()}")
            }

            val buildJson = JsonParser.parseString(buildResponse.body()).asJsonObject
            val downloadsJson = buildJson.getAsJsonObject("downloads")
            val downloadEntry = when {
                downloadsJson.has("server:default") -> downloadsJson.getAsJsonObject("server:default")
                downloadsJson.has("application") -> downloadsJson.getAsJsonObject("application")
                else -> {
                    val firstKey = downloadsJson.keySet().firstOrNull()
                        ?: throw GradleException("No download targets found in build response.")
                    downloadsJson.getAsJsonObject(firstKey)
                }
            }

            val downloadUrl = if (downloadEntry.has("url")) {
                downloadEntry.get("url").asString
            } else {
                val downloadName = downloadEntry.get("name").asString
                "https://fill.papermc.io/v3/projects/paper/versions/$version/builds/$latestBuild/downloads/$downloadName"
            }
            logger.lifecycle("Downloading Paper server from: $downloadUrl")

            val downloadRequest = HttpRequest.newBuilder()
                .uri(URI.create(downloadUrl))
                .GET()
                .build()

            val downloadResponse = httpClient.send(downloadRequest, HttpResponse.BodyHandlers.ofInputStream())

            if (downloadResponse.statusCode() != 200) {
                throw GradleException("Failed to download Paper server. Status: ${downloadResponse.statusCode()}")
            }

            destination.parentFile?.mkdirs()
            Files.copy(downloadResponse.body(), destination.toPath(), StandardCopyOption.REPLACE_EXISTING)

            logger.lifecycle("Paper server downloaded successfully to: ${destination.absolutePath}")

        } catch (e: Exception) {
            throw GradleException("Failed to download Paper server: ${e.message}", e)
        }
    }

    private fun downloadPlugin(httpClient: HttpClient, url: String, pluginsDirectory: File) {
        try {
            val uri = try {
                URI.create(url)
            } catch (e: IllegalArgumentException) {
                throw GradleException("Invalid plugin URL format: $url", e)
            }
            val path = uri.path ?: throw GradleException("Invalid plugin URL: $url (No path found)")
            val fileName = path.substring(path.lastIndexOf('/') + 1)

            if (fileName.isEmpty() || !fileName.endsWith(".jar")) {
                throw GradleException("Invalid plugin URL: $url. The URL path must end with a .jar filename")
            }

            val destination = File(pluginsDirectory, fileName)
            if (destination.exists()) {
                logger.warn("Plugin file already exists and will be overwritten: $fileName")
            }

            logger.lifecycle("Downloading plugin: $fileName from $url")

            val request = HttpRequest.newBuilder()
                .uri(uri)
                .timeout(Duration.ofMinutes(5))
                .GET()
                .build()

            val response = httpClient.send(request, HttpResponse.BodyHandlers.ofInputStream())

            if (response.statusCode() != 200) {
                throw GradleException("Failed to download plugin from $url. Status: ${response.statusCode()}")
            }

            Files.copy(response.body(), destination.toPath(), StandardCopyOption.REPLACE_EXISTING)

            logger.lifecycle("Plugin downloaded successfully: $fileName")

        } catch (e: GradleException) {
            throw e
        } catch (e: Exception) {
            throw GradleException("Failed to download plugin from $url: ${e.message}", e)
        }
    }

    private fun configureBukkitSettings(serverDirectory: File) {
        val bukkitYmlFile = File(serverDirectory, "bukkit.yml")

        try {
            val dumperOptions = DumperOptions().apply {
                defaultFlowStyle = DumperOptions.FlowStyle.BLOCK
                isPrettyFlow = true
            }
            val yaml = Yaml(dumperOptions)

            val bukkitConfig: MutableMap<String, Any> = if (bukkitYmlFile.exists()) {
                val content = bukkitYmlFile.readText()
                yaml.load(content) ?: mutableMapOf()
            } else {
                mutableMapOf()
            }

            @Suppress("UNCHECKED_CAST")
            val settings = bukkitConfig.getOrPut("settings") { mutableMapOf<String, Any>() } as MutableMap<String, Any>

            settings["connection-throttle"] = 0

            val updatedContent = yaml.dump(bukkitConfig)
            bukkitYmlFile.writeText(updatedContent)
            logger.lifecycle("Set connection-throttle to 0 in bukkit.yml")
        } catch (e: Exception) {
            logger.warn("Warning: Could not configure bukkit.yml: ${e.message}")
        }
    }

    private fun configureSpigotSettings(serverDirectory: File) {
        val spigotYmlFile = File(serverDirectory, "spigot.yml")

        try {
            val dumperOptions = DumperOptions().apply {
                defaultFlowStyle = DumperOptions.FlowStyle.BLOCK
                isPrettyFlow = true
            }
            val yaml = Yaml(dumperOptions)

            val spigotConfig: MutableMap<String, Any> = if (spigotYmlFile.exists()) {
                val content = spigotYmlFile.readText()
                yaml.load(content) ?: mutableMapOf()
            } else {
                mutableMapOf()
            }

            @Suppress("UNCHECKED_CAST")
            val settings = spigotConfig.getOrPut("settings") { mutableMapOf<String, Any>() } as MutableMap<String, Any>

            settings["moved-wrongly-threshold"] = 1000.0
            settings["moved-too-quickly-multiplier"] = 1000.0

            val updatedContent = yaml.dump(spigotConfig)
            spigotYmlFile.writeText(updatedContent)
            logger.lifecycle("Set moved-wrongly-threshold and moved-too-quickly-multiplier to 1000 in spigot.yml")
        } catch (e: Exception) {
            logger.warn("Warning: Could not configure spigot.yml: ${e.message}")
        }
    }
}
