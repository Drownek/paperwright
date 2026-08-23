// Loaded once here so every subproject resolves the same Kotlin plugin classes: applying
// `kotlin-dsl` from each subproject's own plugins block loads the Kotlin plugin several
// times over, which Gradle warns about and does not support.
plugins {
    `kotlin-dsl` apply false
}

val projectVersion = file("../version.txt").readText().trim()

allprojects {
    group = "io.github.drownek"
    version = projectVersion

    repositories {
        mavenCentral()
        // The idea-ext plugin marker plugwright-core compiles against lives here, not in Central.
        gradlePluginPortal()
    }
}

subprojects {
    apply(plugin = "org.gradle.kotlin.kotlin-dsl")

    plugins.withId("java") {
        extensions.configure<JavaPluginExtension> {
            toolchain {
                languageVersion.set(JavaLanguageVersion.of(17))
            }
        }
    }
}
