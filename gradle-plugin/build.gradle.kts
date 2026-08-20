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
    plugins.withId("java") {
        extensions.configure<JavaPluginExtension> {
            toolchain {
                languageVersion.set(JavaLanguageVersion.of(17))
            }
        }
    }
}
