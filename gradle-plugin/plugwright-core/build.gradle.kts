val projectVersion = version.toString()

dependencies {
    implementation(gradleApi())
    implementation("com.google.code.gson:gson:2.10.1")
    // Carries `afterSync`, used to run the compile task after an IntelliJ sync. Applied to a
    // consumer's build only when that build already applies the `idea` plugin.
    implementation("org.jetbrains.gradle.plugin.idea-ext:org.jetbrains.gradle.plugin.idea-ext.gradle.plugin:1.4.1")

    // The api module has no separate published coordinates yet, so its classes are
    // merged into this jar below. compileOnly keeps it out of the published POM.
    compileOnly(project(":plugwright-api"))
}

// Until plugwright-api is published on its own, ship it inside this jar so both this
// module and whatever entry-point module publishes it (currently plugwright-local)
// resolve the same contract classes.
val apiJar = project(":plugwright-api").tasks.named("jar", Jar::class)

tasks.named<Jar>("jar") {
    duplicatesStrategy = DuplicatesStrategy.EXCLUDE
    from(apiJar.map { zipTree(it.archiveFile) })
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
