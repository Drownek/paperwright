plugins {
    `java-library`
    id("de.eldoria.plugin-yml.bukkit") version "0.8.0"
    id("com.gradleup.shadow") version "9.0.0"
    id("io.github.drownek.plugwright") version "2.0.3-dev.0"
}

plugwright {
    minecraftVersion.set("1.21.11")
    acceptEula.set(true)
    testsDir.set(file("src/test/e2e"))
    downloadPlugins {
        url("https://hangarcdn.papermc.io/plugins/HelpChat/PlaceholderAPI/versions/2.11.6/PAPER/PlaceholderAPI-2.11.6.jar")
    }
    downloadNode.set(System.getenv("CI") != "true")
}

group = "me.drownek"
version = "1.0-SNAPSHOT"

bukkit {
    main = "me.drownek.example.ExamplePlugin"
    apiVersion = "1.13"
    name = "ExamplePlugin"
    author = "Drownek"

    commands {
        register("example") {
            description = "Example command for plugwright testing"
        }
        register("warps") {
            description = "Warps paginated GUI"
        }
        register("admin") {
            description = "Admin command"
        }
        register("balance") {
            description = "Economy balance command"
        }
        register("pay") {
            description = "Economy pay command"
        }
        register("eco") {
            description = "Economy admin command"
        }
        register("shop") {
            description = "Shop command"
        }
        register("warp") {
            description = "Warp command"
        }
        register("kit") {
            description = "Kit command"
        }
        register("arena") {
            description = "Arena command"
        }
    }
}

repositories {
    mavenCentral()
    maven("https://repo.papermc.io/repository/maven-public/")
}

dependencies {
    compileOnly("org.spigotmc:spigot-api:1.19.4-R0.1-SNAPSHOT")

    /* lombok */
    compileOnly("org.projectlombok:lombok:1.18.40")
    annotationProcessor("org.projectlombok:lombok:1.18.40")
}

tasks.shadowJar {
    archiveFileName.set("bukkit-example-${project.version}.jar")
}

tasks.withType<JavaCompile> {
    options.compilerArgs.add("-parameters")
    options.encoding = "UTF-8"
}

java {
    toolchain {
        languageVersion.set(JavaLanguageVersion.of(21))
    }
}
