val projectVersion = file("../version.txt").readText().trim()

allprojects {
    group = "io.github.drownek"
    version = projectVersion

    repositories {
        mavenCentral()
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
