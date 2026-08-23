dependencies {
    implementation(gradleApi())
    implementation(project(":plugwright-core"))

    // Compile-time only: its classes reach the runtime classpath through the bundle module's
    // merged jar, which is what actually gets published.
    compileOnly(project(":plugwright-api"))
}
