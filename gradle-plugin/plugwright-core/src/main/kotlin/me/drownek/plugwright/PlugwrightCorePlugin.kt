package me.drownek.plugwright

import me.drownek.plugwright.api.ConfigNodeBuilder
import org.gradle.api.GradleException
import org.gradle.api.plugins.ExtensionAware
import org.gradle.api.Plugin
import org.gradle.api.Project
import org.gradle.api.Task
import org.gradle.api.provider.Provider
import org.gradle.api.tasks.TaskProvider
import org.gradle.plugins.ide.idea.model.IdeaModel
import org.jetbrains.gradle.ext.ProjectSettings
import org.jetbrains.gradle.ext.TaskTriggersConfig
import java.io.File
import java.util.concurrent.atomic.AtomicBoolean
import javax.inject.Inject
import org.gradle.process.ExecOperations

interface InjectedExecOps {
    @get:Inject
    val execOperations: ExecOperations
}

object BannerState {
    val printed = AtomicBoolean(false)
}

/**
 * Name of the implicit environment used while the build script has no `environments { }`
 * block: the flat extension properties describe one environment under this name.
 */
const val DEFAULT_ENVIRONMENT_NAME = "local"

/**
 * Mode-agnostic engine: the extension, the shared compile step, and per-environment task
 * generation. Knows nothing about `local`/`external`/any other mode — those register
 * themselves through [PlugwrightExtension.registerMode] before this plugin's
 * `afterEvaluate` runs. See [PlugwrightPlugin] (in the module that publishes the plugin id)
 * for where the built-in modes actually get registered.
 */
class PlugwrightCorePlugin : Plugin<Project> {
    override fun apply(project: Project) {
        val extension = project.extensions.create("plugwright", PlugwrightExtension::class.java, project)

        // Shared per-user cache so Node.js is downloaded once for all projects
        // and survives 'gradle clean'. Safe for concurrent builds thanks to the
        // file lock in NodeManager.
        val defaultNodeInstallDir = File(project.gradle.gradleUserHomeDir, "caches/plugwright/node")

        val plugwrightCompileTests = project.tasks.register("plugwrightCompileTests", PlugwrightCompileTestsTask::class.java) {
            doFirst {
                if (BannerState.printed.compareAndSet(false, true)) Banner.print(project.logger)
            }

            testsDir.set(extension.testsDir)
            nodeVersion.set(extension.nodeVersion)
            downloadNode.set(extension.downloadNode)
            nodeInstallDir.set(defaultNodeInstallDir)
        }

        registerInitTask(project, extension, defaultNodeInstallDir)

        registerIdeaSyncTrigger(project, plugwrightCompileTests)

        project.afterEvaluate {
            wireEnvironments(project, extension, plugwrightCompileTests, defaultNodeInstallDir)
        }
    }

    /**
     * Runs the compile task after an IntelliJ IDEA sync, so a fresh checkout has its
     * `node_modules` and its compiled specs before anyone opens a spec file and finds every
     * import unresolved.
     *
     * Only when the project already applies the `idea` plugin — `idea-ext` is what carries
     * `afterSync`, and applying it unconditionally would push a plugin onto builds that never
     * asked for one.
     *
     * That plugin does not always show up while the project is being configured: an IDEA sync
     * applies it to an already-evaluated project, and `Project.afterEvaluate` throws once that
     * has happened. So the trigger is wired right away in that case and deferred only while
     * configuration is still running.
     */
    private fun registerIdeaSyncTrigger(
        project: Project,
        plugwrightCompileTests: TaskProvider<PlugwrightCompileTestsTask>,
    ) {
        project.plugins.withId("idea") {
            project.pluginManager.apply("org.jetbrains.gradle.plugin.idea-ext")
            if (project.state.executed) {
                wireIdeaSyncTrigger(project, plugwrightCompileTests)
            } else {
                project.afterEvaluate { wireIdeaSyncTrigger(project, plugwrightCompileTests) }
            }
        }
    }

    /**
     * The `taskTriggers` block lives on the root project's `idea.project.settings`, so on a
     * subproject the lookup finds nothing and the trigger is simply skipped.
     */
    private fun wireIdeaSyncTrigger(
        project: Project,
        plugwrightCompileTests: TaskProvider<PlugwrightCompileTestsTask>,
    ) {
        val ideaModel = project.extensions.findByType(IdeaModel::class.java) ?: return
        val ideaProject = ideaModel.project as? ExtensionAware
        val settings = ideaProject?.extensions?.findByType(ProjectSettings::class.java) as? ExtensionAware
        settings?.extensions?.findByType(TaskTriggersConfig::class.java)?.afterSync(plugwrightCompileTests)
    }

    private fun wireEnvironments(
        project: Project,
        extension: PlugwrightExtension,
        plugwrightCompileTests: org.gradle.api.tasks.TaskProvider<PlugwrightCompileTestsTask>,
        defaultNodeInstallDir: File
    ) {
        // No environments { } block: fold the deprecated flat properties into one implicit
        // environment, using whatever mode was registered under the default name.
        if (extension.environments.isEmpty) {
            val entry = extension.environments.createImplicit(DEFAULT_ENVIRONMENT_NAME)
            entry.mode.erased().applyLegacyDefaults(entry.spec, extension)
        }

        val primaryName = extension.primaryEnvironment.get()
        if (extension.environments[primaryName] == null) {
            throw GradleException(
                "plugwright.primaryEnvironment is set to '$primaryName', but no such environment is " +
                    "declared. Declared environments: ${extension.environments.names.joinToString()}"
            )
        }

        val projectPluginJarProvider = resolveProjectPluginJar(project, extension)
        val validationProblems = mutableListOf<String>()
        val reportsDir = project.layout.buildDirectory.dir("reports/plugwright")

        // -Pplugwright.env=a,b narrows the matrix; ignored by direct plugwrightTest<Env> calls.
        val matrixEnvFilter = (project.findProperty("plugwright.env") as? String)
            ?.split(',')?.map { it.trim() }?.filter { it.isNotEmpty() }?.toSet()

        val matrixEntries = mutableListOf<MatrixEnvironmentInput>()
        val matrixPrepareTasks = mutableListOf<TaskProvider<out Task>>()
        val runnerPackageSpecs = linkedSetOf<String>()

        extension.environments.all.forEach { entry ->
            val envName = entry.spec.name
            val mode = entry.mode.erased()
            val ctx = TaskRegistrationContextImpl(
                project, envName, envName == primaryName, projectPluginJarProvider,
                extension.testsDir.map { it.asFile }, extension, defaultNodeInstallDir
            )
            val journalFilePath = project.layout.buildDirectory.file("plugwright/$envName-journal.jsonl").get().asFile

            val testTask = ctx.registerWithoutAlias("Test", PlugwrightTestTask::class.java) {
                doFirst {
                    if (BannerState.printed.compareAndSet(false, true)) Banner.print(project.logger)
                }
                dependsOn(plugwrightCompileTests)
                testsDir.set(extension.testsDir)
                environmentName.set(envName)
                modeId.set(mode.id)
                excludeTests.set(entry.spec.excludeTests)
                configFile.set(project.layout.buildDirectory.file("tmp/plugwright/$envName.json"))
                jsonReportFile.set(reportsDir.map { it.file("$envName.json") })
                junitReportFile.set(reportsDir.map { it.dir("junit").file("$envName.xml") })
                journalFile.set(journalFilePath)
                nodeVersion.set(extension.nodeVersion)
                downloadNode.set(extension.downloadNode)
                nodeInstallDir.set(defaultNodeInstallDir)

                if (project.hasProperty("testFiles")) testFiles.set(project.property("testFiles") as String)
                if (project.hasProperty("testNames")) testNames.set(project.property("testNames") as String)
            }

            val validation = ValidationContextImpl(envName, project.logger)
            mode.validate(entry.spec, validation)
            validationProblems += validation.errors.map { "[$envName] $it" }

            mode.registerTasks(entry.spec, ctx)

            val environmentConfigProvider = ctx.environmentConfigProvider
                ?: project.provider { ConfigNodeBuilder().apply { mode.serialize(entry.spec, this) }.build() }
            val pluginConfigsProvider = ctx.pluginConfigsProvider
                ?: project.provider { emptyList() }

            testTask.configure {
                ctx.prepareTaskRef?.let { dependsOn(it) }
                environmentConfig.set(environmentConfigProvider)
                pluginConfigs.set(pluginConfigsProvider)
            }

            if (entry.spec.includeInMatrix.get() && (matrixEnvFilter == null || envName in matrixEnvFilter)) {
                val reportsDirFile = reportsDir.get().asFile
                matrixEntries += MatrixEnvironmentInput(
                    name = envName,
                    modeId = mode.id,
                    allowFailure = entry.spec.allowFailure.get(),
                    testsDir = extension.testsDir.get().asFile,
                    configFile = project.layout.buildDirectory.file("tmp/plugwright/$envName.json").get().asFile,
                    jsonReportFile = File(reportsDirFile, "$envName.json"),
                    junitReportFile = File(File(reportsDirFile, "junit"), "$envName.xml"),
                    logFile = File(reportsDirFile, "$envName.log"),
                    excludeTests = entry.spec.excludeTests.get(),
                    environmentConfig = environmentConfigProvider,
                    pluginConfigs = pluginConfigsProvider,
                    journalFile = journalFilePath,
                )
                ctx.prepareTaskRef?.let { matrixPrepareTasks += it }
            }
        }

        if (validationProblems.isNotEmpty()) {
            throw GradleException("plugwright configuration problems:\n" + validationProblems.joinToString("\n") { "  $it" })
        }

        project.tasks.register("plugwrightTest", PlugwrightMatrixTask::class.java) {
            doFirst {
                if (BannerState.printed.compareAndSet(false, true)) Banner.print(project.logger)
            }
            dependsOn(plugwrightCompileTests)
            matrixPrepareTasks.forEach { dependsOn(it) }
            entries = matrixEntries
            parallel.set(extension.matrix.parallel)
            maxParallel.set(extension.matrix.maxParallel)
            nodeVersion.set(extension.nodeVersion)
            downloadNode.set(extension.downloadNode)
            nodeInstallDir.set(defaultNodeInstallDir)
            if (project.hasProperty("testFiles")) testFiles.set(project.property("testFiles") as String)
            if (project.hasProperty("testNames")) testNames.set(project.property("testNames") as String)
        }
    }

    /** The jar of the plugin under test, from `shadowJar` / `reobfJar` / `jar`. Absent when
     *  the build asked for external plugins only, or when no jar-producing task exists. */
    private fun resolveProjectPluginJar(project: Project, extension: PlugwrightExtension): Provider<File> {
        if (extension.useExternalPluginsOnly.get()) {
            return project.objects.property(File::class.java)
        }
        val jarTask = when {
            project.tasks.findByName("shadowJar") != null -> project.tasks.named("shadowJar")
            project.tasks.findByName("reobfJar") != null -> project.tasks.named("reobfJar")
            project.tasks.findByName("jar") != null -> project.tasks.named("jar")
            else -> null
        } ?: return project.objects.property(File::class.java)
        return jarTask.map { it.outputs.files.singleFile }
    }

    private fun registerInitTask(project: Project, extension: PlugwrightExtension, defaultNodeInstallDir: File) {
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
                    if (System.console() != null) {
                        project.logger.lifecycle("Enter the test directory location [default: $defaultDir]:")
                        val consoleInput = readlnOrNull()?.trim()
                        if (consoleInput.isNullOrEmpty()) defaultDir else consoleInput
                    } else {
                        project.logger.lifecycle("Non-interactive environment detected. Using default test directory: $defaultDir")
                        defaultDir
                    }
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
                            "@drownek/plugwright": "^2.0.3"
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
                val nodePaths = NodeManager.getOrDownloadNode(defaultNodeInstallDir, extension.nodeVersion.get(), extension.downloadNode.get())

                try {
                    val isWin = System.getProperty("os.name").lowercase().contains("windows")
                    val cmd = if (isWin) listOf("cmd", "/c", nodePaths.npm, "install") else listOf(nodePaths.npm, "install")
                    val nodeDir = File(nodePaths.node).parent

                    val execOps = project.objects.newInstance(InjectedExecOps::class.java)
                    val execResult = execOps.execOperations.exec {
                        workingDir = targetDir
                        commandLine = cmd
                        if (nodeDir != null) {
                            val pathKey = environment.keys.firstOrNull { it.equals("PATH", ignoreCase = true) } ?: "PATH"
                            environment[pathKey] = nodeDir + File.pathSeparator + (environment[pathKey] ?: "")
                        }
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
    }
}
