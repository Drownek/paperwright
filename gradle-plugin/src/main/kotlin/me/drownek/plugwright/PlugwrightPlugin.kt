package me.drownek.plugwright

import org.gradle.api.GradleException
import org.gradle.api.Plugin
import org.gradle.api.Project
import org.gradle.api.plugins.JavaPluginExtension
import org.gradle.jvm.toolchain.JavaToolchainService
import java.util.concurrent.atomic.AtomicBoolean

object BannerState {
    val printed = AtomicBoolean(false)
}

class PlugwrightPlugin : Plugin<Project> {
    override fun apply(project: Project) {
        val extension = project.extensions.create("plugwright", PlugwrightExtension::class.java, project)

        // Register plugwrightClean task
        val plugwrightClean = project.tasks.register("plugwrightClean") {
            group = "verification"
            description = "Wipes the test server data for a clean slate."

            doFirst {
                if (BannerState.printed.compareAndSet(false, true)) Banner.print(project.logger)
            }

            doLast {
                val runDir = extension.runDir.get().asFile
                val excludePatterns = extension.cleanExcludePatterns.get()

                if (!runDir.exists()) {
                    project.logger.lifecycle("  Run directory doesn't exist yet, nothing to clean")
                    return@doLast
                }

                project.logger.lifecycle("  Cleaning run directory (excluding: ${excludePatterns.joinToString(", ")})")

                // Get all files and directories in the run folder
                val allEntries = runDir.listFiles() ?: emptyArray()

                // Separate entries into deleted and kept
                val deletedFiles = mutableListOf<String>()
                val keptFiles = mutableListOf<String>()

                // Delete everything except the excluded patterns
                allEntries.forEach { entry ->
                    val shouldExclude = excludePatterns.any { pattern ->
                        entry.name == pattern
                    }

                    if (!shouldExclude) {
                        deletedFiles.add(entry.name)
                        project.delete(entry)
                    } else {
                        keptFiles.add(entry.name)
                    }
                }

                if (deletedFiles.isNotEmpty()) {
                    project.logger.lifecycle("    deleted:   ${deletedFiles.joinToString(", ")}")
                }
                if (keptFiles.isNotEmpty()) {
                    project.logger.lifecycle("    preserved: ${keptFiles.joinToString(", ")}")
                }
            }
        }

        project.tasks.register("plugwrightTest", PlugwrightTestTask::class.java) {
            // Ensure clean runs before test
            dependsOn(plugwrightClean)

            doFirst {
                if (BannerState.printed.compareAndSet(false, true)) Banner.print(project.logger)
            }

            testsDir.set(extension.testsDir)
            minecraftVersion.set(extension.minecraftVersion)
            jvmArgs.set(extension.jvmArgs)
            acceptEula.set(extension.acceptEula)
            pluginUrls.set(extension.pluginUrls)
            runDirFiles.set(extension.runDirFiles)
            nodeVersion.set(extension.nodeVersion)
            downloadNode.set(extension.downloadNode)
            nodeInstallDir.set(project.layout.buildDirectory.dir("plugwright/node"))

            // Support command line properties for filtering
            if (project.hasProperty("testFiles")) {
                testFiles.set(project.property("testFiles") as String)
            }

            if (project.hasProperty("testNames")) {
                testNames.set(project.property("testNames") as String)
            }

            serverJarPath.set(
                extension.runDir.map { runDir ->
                    val serverJar = runDir.asFile.resolve("server.jar")
                    serverJar.absolutePath
                }
            )

            serverDir.set(
                extension.runDir.map { runDir ->
                    runDir.asFile.absolutePath
                }
            )

            // Configure Java Toolchain if Java plugin is present
            project.plugins.withId("java") {
                val javaExtension = project.extensions.findByType(JavaPluginExtension::class.java)
                val javaToolchains = project.extensions.findByType(JavaToolchainService::class.java)

                if (javaExtension != null && javaToolchains != null) {
                    javaLauncher.set(javaToolchains.launcherFor(javaExtension.toolchain))
                }
            }
        }

        project.tasks.register("plugwrightRunServer", PlugwrightRunTask::class.java) {
            // Ensure clean runs before starting the server
            dependsOn(plugwrightClean)

            doFirst {
                if (BannerState.printed.compareAndSet(false, true)) Banner.print(project.logger)
            }

            minecraftVersion.set(extension.minecraftVersion)
            jvmArgs.set(extension.jvmArgs)
            acceptEula.set(extension.acceptEula)
            pluginUrls.set(extension.pluginUrls)
            runDirFiles.set(extension.runDirFiles)
            nodeVersion.set(extension.nodeVersion)
            downloadNode.set(extension.downloadNode)

            serverJarPath.set(
                extension.runDir.map { runDir ->
                    val serverJar = runDir.asFile.resolve("server.jar")
                    serverJar.absolutePath
                }
            )

            serverDir.set(
                extension.runDir.map { runDir ->
                    runDir.asFile.absolutePath
                }
            )

            // Configure Java Toolchain if Java plugin is present
            project.plugins.withId("java") {
                val javaExtension = project.extensions.findByType(JavaPluginExtension::class.java)
                val javaToolchains = project.extensions.findByType(JavaToolchainService::class.java)

                if (javaExtension != null && javaToolchains != null) {
                    javaLauncher.set(javaToolchains.launcherFor(javaExtension.toolchain))
                }
            }
        }

        project.tasks.register("plugwrightInit") {
            group = "verification"
            description = "Interactively initializes a plugwright-test environment with required configs and an initial test file."
            
            doFirst {
                if (BannerState.printed.compareAndSet(false, true)) Banner.print(project.logger)
            }

            doLast {
                val defaultDir = "src/test/e2e"
                val propertyDir = project.findProperty("plugwrightDir") as? String

                val inputDir = propertyDir ?: run {
                    project.logger.lifecycle("Enter the test directory location [default: $defaultDir]:")
                    val consoleInput = readlnOrNull()?.trim()
                    if (consoleInput.isNullOrEmpty()) defaultDir else consoleInput
                }

                project.logger.lifecycle("Using directory: $inputDir")

                val projectRootDir = project.projectDir.canonicalFile
                val targetDir = projectRootDir.resolve(inputDir).canonicalFile

                if (!targetDir.path.startsWith(projectRootDir.path)) {
                    throw GradleException("SECURITY ERROR: Target directory ($targetDir) resolves outside the project root directory. Path traversal aborted.")
                }

                if (!targetDir.exists() && !targetDir.mkdirs()) {
                    throw GradleException("IO ERROR: Failed to create target directory: ${targetDir.absolutePath}. Check your file permissions.")
                }

                val packageJson = targetDir.resolve("package.json")
                if (!packageJson.exists()) {
                    packageJson.writeText(
                        """
                        {
                          "type": "module",
                          "scripts": {
                            "build": "rimraf dist && tsc"
                          },
                          "dependencies": {
                            "@drownek/plugwright": "^2.0.2"
                          },
                          "devDependencies": {
                            "@types/node": "^22.10.5",
                            "rimraf": "^6.1.3",
                            "typescript": "^5.7.3"
                          }
                        }
                        """.trimIndent()
                    )
                    project.logger.lifecycle("Created: ${packageJson.absolutePath}")
                }

                val tsconfigJson = targetDir.resolve("tsconfig.json")
                if (!tsconfigJson.exists()) {
                    tsconfigJson.writeText(
                        """
                        {
                          "compilerOptions": {
                            "target": "ES2022",
                            "module": "ES2022",
                            "moduleResolution": "node",
                            "lib": ["ES2022"],
                            "outDir": "./dist",
                            "rootDir": ".",
                            "strict": true,
                            "esModuleInterop": true,
                            "skipLibCheck": true,
                            "forceConsistentCasingInFileNames": true,
                            "resolveJsonModule": true,
                            "declaration": false,
                            "sourceMap": true
                          },
                          "include": [
                            "*.spec.ts"
                          ],
                          "exclude": [
                            "node_modules",
                            "dist"
                          ]
                        }
                        """.trimIndent()
                    )
                    project.logger.lifecycle("Created: ${tsconfigJson.absolutePath}")
                }

                val testFile = targetDir.resolve("example.spec.ts")
                if (!testFile.exists()) {
                    testFile.writeText(
                        """
                        import {expect, test} from '@drownek/plugwright';
                        
                        test('help displays message', async ({ player, server }) => {
                          player.chat('/help');
                          await expect(player).toHaveReceivedMessage('Help');
                        });
                        """.trimIndent()
                    )
                    project.logger.lifecycle("Created: ${testFile.absolutePath}")
                }

                project.logger.lifecycle("Executing 'npm install' in ${targetDir.absolutePath}...")
                val nodePaths = NodeManager.getOrDownloadNode(project, extension.nodeVersion.get(), extension.downloadNode.get())

                try {
                    val isWin = System.getProperty("os.name").lowercase().contains("windows")
                    val cmd = if (isWin) listOf("cmd", "/c", nodePaths.npm, "install") else listOf(nodePaths.npm, "install")
                    val execResult = project.exec {
                        workingDir = targetDir
                        commandLine = cmd
                        isIgnoreExitValue = true
                    }

                    if (execResult.exitValue != 0) {
                        throw GradleException("EXEC ERROR: 'npm install' failed with exit code ${execResult.exitValue}.")
                    }
                    project.logger.lifecycle("Dependencies installed successfully.")
                    project.logger.lifecycle("\nYou're all set! Run tests with: ./gradlew plugwrightTest")
                } catch (e: Exception) {
                    if (e is GradleException) throw e
                    throw GradleException("EXEC FATAL: Failed to launch npm process. Original error: ${e.message}", e)
                }
            }
        }

        project.afterEvaluate {
            // Only set up plugin jar dependency if not using external plugins only
            if (!extension.useExternalPluginsOnly.get()) {
                // Try to find the task that produces the plugin jar
                val jarTask = when {
                    project.tasks.findByName("shadowJar") != null -> project.tasks.named("shadowJar")
                    project.tasks.findByName("reobfJar") != null -> project.tasks.named("reobfJar")
                    else -> project.tasks.named("jar")
                }

                if (jarTask.isPresent) {
                    project.tasks.named("plugwrightTest", PlugwrightTestTask::class.java).configure {
                        pluginJar.set(jarTask.map { it.outputs.files.singleFile })
                    }
                    project.tasks.named("plugwrightRunServer", PlugwrightRunTask::class.java).configure {
                        pluginJar.set(jarTask.map { it.outputs.files.singleFile })
                    }
                }
            }
        }
    }
}
