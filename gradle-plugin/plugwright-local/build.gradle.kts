dependencies {
    implementation(gradleApi())
    implementation("com.google.code.gson:gson:2.10.1")
    implementation("org.yaml:snakeyaml:2.0")
    implementation(project(":plugwright-core"))

    // Compile-time only: its classes reach the runtime classpath through the bundle module's
    // merged jar, which is what actually gets published.
    compileOnly(project(":plugwright-api"))
}
