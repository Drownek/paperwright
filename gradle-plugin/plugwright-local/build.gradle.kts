plugins {
    `kotlin-dsl`
    `maven-publish`
    id("com.gradle.plugin-publish") version "1.2.1"
}

dependencies {
    implementation(gradleApi())
    implementation("com.google.code.gson:gson:2.10.1")
    implementation("org.yaml:snakeyaml:2.0")
    implementation(project(":plugwright-core"))

    // Compile-time only: its classes reach the runtime classpath through plugwright-core's
    // jar, which this module re-merges below.
    compileOnly(project(":plugwright-api"))
}

// This is the module published under the plugin id, so its jar must carry the api and
// core classes too — neither is published under its own coordinates.
val apiJar = project(":plugwright-api").tasks.named("jar", Jar::class)
val coreJar = project(":plugwright-core").tasks.named("jar", Jar::class)

tasks.named<Jar>("jar") {
    duplicatesStrategy = DuplicatesStrategy.EXCLUDE
    from(apiJar.map { zipTree(it.archiveFile) })
    from(coreJar.map { zipTree(it.archiveFile) })
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
