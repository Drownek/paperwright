plugins {
    `kotlin-dsl`
    `maven-publish`
    id("com.gradle.plugin-publish") version "1.2.1"
}

val projectVersion = version.toString()

dependencies {
    implementation(gradleApi())
    implementation("com.google.code.gson:gson:2.10.1")
    implementation("org.yaml:snakeyaml:2.0")

    // The api module has no separate published coordinates yet, so its classes are
    // merged into this jar below. compileOnly keeps it out of the published POM.
    compileOnly(project(":plugwright-api"))
}

// Until plugwright-api is published on its own, ship it inside the plugin jar so
// both this plugin and third-party mode jars resolve the same contract classes.
val apiJar = project(":plugwright-api").tasks.named("jar", Jar::class)

tasks.named<Jar>("jar") {
    duplicatesStrategy = DuplicatesStrategy.EXCLUDE
    from(apiJar.map { zipTree(it.archiveFile) })
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

val generateVersionResource = tasks.register("generateVersionResource") {
    val outFile = layout.buildDirectory.file("generated/version-resource/plugwright-version.properties")
    inputs.property("version", projectVersion)
    outputs.file(outFile)
    doLast {
        val f = outFile.get().asFile
        f.parentFile.mkdirs()
        f.writeText("version=$projectVersion\n")
    }
}

sourceSets.named("main") {
    resources.srcDir(generateVersionResource.map { it.outputs.files.singleFile.parentFile })
}
