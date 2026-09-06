plugins {
    `maven-publish`
    id("com.gradle.plugin-publish") version "1.2.1"
}

// This module's jar physically embeds the other modules' classes (see below), so their jar
// tasks must be configured before this script reaches that point.
evaluationDependsOn(":plugwright-api")
evaluationDependsOn(":plugwright-core")
evaluationDependsOn(":plugwright-local")
evaluationDependsOn(":plugwright-external")

dependencies {
    implementation(gradleApi())
    implementation("com.google.code.gson:gson:2.10.1")
    implementation("org.yaml:snakeyaml:2.0")
    implementation("org.jetbrains.gradle.plugin.idea-ext:org.jetbrains.gradle.plugin.idea-ext.gradle.plugin:1.4.1")

    // Compile-time only, all four: none of them is published under its own coordinates, and
    // their classes reach the runtime classpath through this module's merged jar below.
    //
    // As `implementation` they would instead be written into the published POM as runtime
    // dependencies on io.github.drownek:plugwright-core, -local and -external — coordinates
    // that exist in no repository, so every consumer resolving this plugin from a maven
    // repository failed with "Could not find io.github.drownek:plugwright-core".
    //
    // gson, snakeyaml and idea-ext above stay `implementation` deliberately: those are real
    // artifacts that are not merged into the jar, so the POM does have to ask for them.
    compileOnly(project(":plugwright-api"))
    compileOnly(project(":plugwright-core"))
    compileOnly(project(":plugwright-local"))
    compileOnly(project(":plugwright-external"))
}

// This is the module published under the plugin id, so its jar must carry the api, core and
// mode classes too — none of them are published under their own coordinates.
val apiJar = project(":plugwright-api").tasks.named("jar", Jar::class)
val coreJar = project(":plugwright-core").tasks.named("jar", Jar::class)
val localJar = project(":plugwright-local").tasks.named("jar", Jar::class)
val externalJar = project(":plugwright-external").tasks.named("jar", Jar::class)

tasks.named<Jar>("jar") {
    duplicatesStrategy = DuplicatesStrategy.EXCLUDE
    from(apiJar.map { zipTree(it.archiveFile) })
    from(coreJar.map { zipTree(it.archiveFile) })
    from(localJar.map { zipTree(it.archiveFile) })
    from(externalJar.map { zipTree(it.archiveFile) })
}

gradlePlugin {
    website.set("https://github.com/drownek/plugwright")
    vcsUrl.set("https://github.com/drownek/plugwright.git")
    plugins {
        create("plugwright") {
            id = "io.github.drownek.plugwright"
            displayName = "Plugwright Testing Plugin"
            description = "End-to-end testing framework for Paper/Spigot Minecraft plugins"
            tags.set(listOf("minecraft", "paper", "spigot", "testing", "e2e"))
            implementationClass = "me.drownek.plugwright.PlugwrightPlugin"
        }
    }
}

// An organisation that cannot reach the Gradle Plugin Portal needs the plugin somewhere it
// can reach, so the plugin is publishable to an arbitrary maven repository as well.
//
// Nothing about that repository is written down here: a URL in this file would tie an
// otherwise public build to one company's infrastructure, and a password in it would be a
// password in version control. All three come from properties or the environment, and the
// repository only exists when the URL does — a build without them publishes exactly where it
// did before.
val publishUrl = providers.gradleProperty("plugwright.publish.url")
    .orElse(providers.environmentVariable("PLUGWRIGHT_PUBLISH_URL"))
val publishUser = providers.gradleProperty("plugwright.publish.user")
    .orElse(providers.environmentVariable("PLUGWRIGHT_PUBLISH_USER"))
val publishPassword = providers.gradleProperty("plugwright.publish.password")
    .orElse(providers.environmentVariable("PLUGWRIGHT_PUBLISH_PASSWORD"))

publishing {
    repositories {
        if (publishUrl.isPresent) {
            maven {
                name = "private"
                url = uri(publishUrl.get())

                // A repository that lets anyone write is its own kind of problem, but it is
                // not this build's to solve: an anonymous deploy is still a valid one.
                if (publishUser.isPresent && publishPassword.isPresent) {
                    credentials {
                        username = publishUser.get()
                        password = publishPassword.get()
                    }
                }
            }
        }
    }
}

// Either destination can be switched off, and neither being available is a normal state
// rather than a failure.
//
// The public one is on by default: it is where a release goes. The private one is off until a
// repository is named, because most builds have none — a build that never opted in has nothing
// to publish privately, and treating that as an error would make `publishToPrivateRepository`
// fail on every checkout that has not been set up.
//
// The explicit properties exist for the case the implicit rule gets wrong: a fork that
// publishes only inside a company wants the public one off, and a machine that has the private
// URL in its environment for resolving may still want to publish nowhere.
val publicEnabled = providers.gradleProperty("plugwright.publish.public.enabled")
    .orElse(providers.environmentVariable("PLUGWRIGHT_PUBLISH_PUBLIC_ENABLED"))
    .map { it.toBoolean() }
    .orElse(true)
val privateEnabled = providers.gradleProperty("plugwright.publish.private.enabled")
    .orElse(providers.environmentVariable("PLUGWRIGHT_PUBLISH_PRIVATE_ENABLED"))
    .map { it.toBoolean() }
    .orElse(publishUrl.map { true })
    .orElse(false)

// The two destinations under one pair of names, so a release reads the same whichever it is
// going to. Both wrap tasks that already exist — `publishPlugins` from the plugin-publish
// plugin, and the publication task Gradle derives from the repository above.
//
// The switch goes on the wrapped task, not on the wrapper: `onlyIf` skips the task it is set
// on and nothing it depends on, so a wrapper that skipped itself would still have run the
// publish underneath it.
tasks.named("publishPlugins") {
    onlyIf { publicEnabled.get() }
}

tasks.register("publishToPublicRepository") {
    group = "publishing"
    description = "Publishes the plugin to the Gradle Plugin Portal, unless it is switched off."
    dependsOn(tasks.named("publishPlugins"))

    doLast {
        if (!publicEnabled.get()) {
            logger.lifecycle("Public publishing is off (plugwright.publish.public.enabled=false).")
        }
    }
}

if (publishUrl.isPresent) {
    tasks.named("publishAllPublicationsToPrivateRepository") {
        onlyIf { privateEnabled.get() }
    }
}

tasks.register("publishToPrivateRepository") {
    group = "publishing"
    description = "Publishes the plugin to the maven repository named by plugwright.publish.url, when there is one."

    if (publishUrl.isPresent) {
        dependsOn(tasks.named("publishAllPublicationsToPrivateRepository"))
    }

    // Says why it did nothing rather than failing. The task is registered whether or not a
    // repository is configured, so a build script and a CI job can name it unconditionally.
    doLast {
        if (!publishUrl.isPresent) {
            logger.lifecycle(
                "No private repository configured, nothing published. Set plugwright.publish.url " +
                "(or PLUGWRIGHT_PUBLISH_URL), plus plugwright.publish.user and " +
                "plugwright.publish.password if the repository asks for them."
            )
        } else if (!privateEnabled.get()) {
            logger.lifecycle("Private publishing is off (plugwright.publish.private.enabled=false).")
        }
    }
}

// `maven-publish` already registers `publish` as the lifecycle task for this module, but on
// its own it only reaches the private repository above; the portal side lives under
// `plugin-publish`'s `publishPlugins` and never joins it on its own. Wiring both wrapper
// tasks onto `publish` makes it the one command a release runs, still skipping either side
// exactly as `publishToPrivateRepository`/`publishToPublicRepository` do on their own.
tasks.named("publish") {
    dependsOn(tasks.named("publishToPrivateRepository"), tasks.named("publishToPublicRepository"))
}
