package me.drownek.plugwright

import me.drownek.plugwright.api.ConfigNodeBuilder
import me.drownek.plugwright.api.PluginRef
import me.drownek.plugwright.api.PlugwrightLayout
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
            // Filled in once every environment has been wired; empty until then.
            runnerPackages.convention(emptyList())
            npmConfig.set(project.provider { extension.npm.toConfig() })
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
        plugwrightCompileTests: TaskProvider<PlugwrightCompileTestsTask>,
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

        val layout = PlugwrightLayout.of(extension.testsDir.get().asFile)
        val projectPluginJarProvider = resolveProjectPluginJar(project, extension)
        val validationProblems = mutableListOf<String>()
        validationProblems += extension.npm.toConfig().problems().map { "[npm] $it" }
        val reportsDir = project.layout.buildDirectory.dir("reports/plugwright")

        // -Pplugwright.env=a,b narrows the matrix; ignored by direct plugwrightTest<Env> calls.
        val matrixEnvFilter = (project.findProperty("plugwright.env") as? String)
            ?.split(',')?.map { it.trim() }?.filter { it.isNotEmpty() }?.toSet()

        val matrixEntries = mutableListOf<MatrixEnvironmentInput>()
        val matrixPrepareTasks = mutableListOf<TaskProvider<out Task>>()
        // Keyed by package name rather than by the whole spec: a mode names a package with the
        // version it needs, and the same build script names it again — bare — in that
        // environment's plugins { npm(...) }. Both specs in one `npm install` is a package
        // asked for twice at two different versions, and the bare one resolves "latest",
        // which a package released only under another tag does not have.
        val runnerPackageSpecs = linkedMapOf<String, String>()
        fun addRunnerPackage(spec: String) {
            val name = npmPackageNameOf(spec)
            val existing = runnerPackageSpecs[name]
            when {
                // A version beats no version; between two versions the mode's comes first and
                // wins, because it is the half that knows what its own export needs.
                existing == null || existing == name -> runnerPackageSpecs[name] = spec
                spec == name || spec == existing -> Unit
                else -> project.logger.warn(
                    "plugwright: $name is asked for as both '$existing' and '$spec'. Installing " +
                        "'$existing'; drop the version from one of them to say which you meant."
                )
            }
        }

        extension.environments.all.forEach { entry ->
            val envName = entry.spec.name
            val mode = entry.mode.erased()
            // Before validation and registerTasks: a mode fills in what it can derive from
            // the layout here, and both of those already expect a complete spec.
            mode.applyLayoutDefaults(entry.spec, layout)
            val ctx = TaskRegistrationContextImpl(
                project, envName, envName == primaryName, projectPluginJarProvider,
                extension.testsDir.map { it.asFile }, layout, extension, defaultNodeInstallDir
            )
            val modePackages = mode.runnerPackages(entry.spec)

            // The package a mode names an export in is the one holding its environment factory.
            // Only a third-party mode needs it written into the config; `local` and `external`
            // are compiled into the runner, which resolves them by mode id.
            val runtimeRef = if (mode.id == "local" || mode.id == "external") {
                null
            } else {
                modePackages.firstOrNull { it.export != null }
            }

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
                nodeVersion.set(extension.nodeVersion)
                downloadNode.set(extension.downloadNode)
                nodeInstallDir.set(defaultNodeInstallDir)
                runtimeRef?.let { ref ->
                    runtimePackage.set(ref.name)
                    ref.export?.let { runtimeExport.set(it) }
                }
                if (project.hasProperty("testFiles")) testFiles.set(project.property("testFiles") as String)
                if (project.hasProperty("testNames")) testNames.set(project.property("testNames") as String)
            }

            // Merged across environments so the whole matrix is covered by one install.
            modePackages.forEach { ref ->
                addRunnerPackage(if (ref.version != null) "${ref.name}@${ref.version}" else ref.name)
            }

            val validation = ValidationContextImpl(envName, project.logger)
            mode.validate(entry.spec, validation)
            validationProblems += validation.errors.map { "[$envName] $it" }

            mode.registerTasks(entry.spec, ctx)

            val environmentConfigProvider = ctx.environmentConfigProvider
                ?: project.provider { ConfigNodeBuilder().apply { mode.serialize(entry.spec, this) }.build() }
            val pluginConfigsProvider = (ctx.pluginConfigsProvider ?: project.provider { emptyList() })
                .map { refs -> refs.map { resolveWorkspacePlugin(it, layout) } }

            // A plugin declared by npm name is installed alongside the environment's own
            // runner packages; a plugin given as a path is already in the project.
            pluginConfigsProvider.get()
                .map { it.specifier }
                .filter { isNpmPackageName(it) }
                .forEach { addRunnerPackage(it) }

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
                    workspaceDir = layout.workspaceDir,
                    configFile = project.layout.buildDirectory.file("tmp/plugwright/$envName.json").get().asFile,
                    jsonReportFile = File(reportsDirFile, "$envName.json"),
                    junitReportFile = File(File(reportsDirFile, "junit"), "$envName.xml"),
                    logFile = File(reportsDirFile, "$envName.log"),
                    excludeTests = entry.spec.excludeTests.get(),
                    environmentConfig = environmentConfigProvider,
                    pluginConfigs = pluginConfigsProvider,
                    runtimePackage = runtimeRef?.name,
                    runtimeExport = runtimeRef?.export,
                )
                ctx.prepareTaskRef?.let { matrixPrepareTasks += it }
            }
        }

        plugwrightCompileTests.configure { runnerPackages.set(runnerPackageSpecs.values.toList()) }

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

    /** Turns `plugins { local("stand-reset") }` into the path the compiler writes it to.
     *  Anything else — an npm name, a path the build script spelled out — passes through. */
    private fun resolveWorkspacePlugin(ref: PluginRef, layout: PlugwrightLayout): PluginRef {
        if (!ref.specifier.startsWith(PluginRef.WORKSPACE_SCHEME)) return ref
        val name = ref.specifier.removePrefix(PluginRef.WORKSPACE_SCHEME)
        return ref.copy(specifier = File(layout.compiledPluginsDir, "$name.js").absolutePath)
    }

    /** `@scope/name@^1.0.0` → `@scope/name`; the version separator is the last `@`, which for
     *  a scoped package is never the leading one. A git/URL spec (`git+ssh://git@host/repo`,
     *  `https://user:pass@registry/pkg`) carries its own `@`s that aren't a version separator
     *  at all, so it is returned as-is instead of being cut at the last one. */
    private fun npmPackageNameOf(spec: String): String {
        if (spec.contains("://") || spec.startsWith("git+")) return spec
        val separator = spec.lastIndexOf('@')
        return if (separator > 0) spec.substring(0, separator) else spec
    }

    /** Whether a plugin specifier names an npm package rather than a file in the project.
     *  Paths are what `plugins { local(file(...)) }` produces; everything else is installable. */
    private fun isNpmPackageName(specifier: String): Boolean {
        if (specifier.startsWith(".") || specifier.startsWith("/") || specifier.startsWith("\\")) return false
        if (specifier.length > 1 && specifier[1] == ':') return false
        return true
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

                val layout = PlugwrightLayout.of(targetDir)
                writeGitignore(project, targetDir)
                writeIfAbsent(project, targetDir.resolve("package.json"), initTemplate("package.json"))
                writeIfAbsent(project, targetDir.resolve("tsconfig.json"), initTemplate("tsconfig.json"))
                writeIfAbsent(project, layout.testsDir.resolve("example.spec.ts"), initTemplate("example.spec.ts"))
                writeIfAbsent(project, layout.pluginsDir.resolve("example-plugin.ts"), initTemplate("example-plugin.ts"))

                // The install below is the first one this workspace runs, so it needs the
                // registries too — a scaffold that can only reach the public registry is no
                // use to a project that lives behind a private one.
                NpmrcWriter.write(targetDir, extension.npm.toConfig(), project.logger)

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
                    project.logger.lifecycle(
                        "To load the example plugin, add plugins { local(\"example-plugin\") } to an environment."
                    )
                } catch (e: Exception) {
                    if (e is GradleException) throw e
                    throw GradleException("EXEC FATAL: Failed to launch npm process. Original error: ${e.message}", e)
                }
            }
        }
    }

    private fun writeIfAbsent(project: Project, file: File, content: String) {
        if (file.exists()) return
        file.parentFile?.mkdirs()
        file.writeText(content)
        project.logger.lifecycle("Created: ${file.absolutePath}")
    }

    /**
     * One of the files `plugwrightInit` scaffolds, from `src/main/resources/plugwright-init`.
     *
     * They are real `.ts` / `.json` files rather than string literals in here, so an editor
     * checks them and nothing has to be escaped past the Kotlin parser. `@runnerVersion@` is
     * the only placeholder.
     */
    private fun initTemplate(name: String): String {
        val stream = PlugwrightCorePlugin::class.java.getResourceAsStream("/plugwright-init/$name")
            ?: throw GradleException("plugwright is missing its '$name' template. Reinstall the plugin.")
        return stream.bufferedReader().use { it.readText() }
            .replace("@runnerVersion@", runnerVersionRange())
    }

    /**
     * Keeps the three generated directories out of version control.
     *
     * Appends to a `.gitignore` that is already there rather than replacing it: the workspace
     * may well have entries of its own, and none of them are this task's to decide about.
     */
    private fun writeGitignore(project: Project, workspaceDir: File) {
        val gitignore = File(workspaceDir, ".gitignore")
        val template = initTemplate("gitignore")

        if (!gitignore.exists()) {
            gitignore.writeText(template)
            project.logger.lifecycle("Created: ${gitignore.absolutePath}")
            return
        }

        val required = template.lines().map { it.trim() }.filter { it.isNotEmpty() && !it.startsWith("#") }
        val present = gitignore.readLines().map { it.trim().trimEnd('/') }.toSet()
        val missing = required.filter { it.trimEnd('/') !in present }
        if (missing.isEmpty()) return

        val separator = if (gitignore.readText().endsWith("\n")) "" else "\n"
        gitignore.appendText(separator + missing.joinToString("\n", postfix = "\n"))
        project.logger.lifecycle("Added ${missing.joinToString(", ")} to ${gitignore.absolutePath}")
    }

    /**
     * npm range for the runner that goes with this plugin: `2.0.4-dev.0` asks for `^2.0.0`.
     *
     * The runner and the plugin are released together, so the plugin's own version is the
     * right thing to derive from — but only down to the minor. A pre-release plugin names a
     * patch npm has never seen, and `^2.0.0` resolves to the newest 2.x either way.
     */
    private fun runnerVersionRange(): String {
        val match = Regex("""^(\d+)\.(\d+)\.""").find(Banner.pluginVersion()) ?: return "latest"
        val (major, minor) = match.destructured
        return "^$major.$minor.0"
    }
}
