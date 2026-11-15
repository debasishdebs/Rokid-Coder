// The build's own plugins, as an included build (pluginManagement in the root settings). It holds no
// product code: only what assembles the release, so ./gradlew -p build-logic test checks it alone.
dependencyResolutionManagement {
    repositories {
        google()
        mavenCentral()
        gradlePluginPortal()
    }
}

rootProject.name = "build-logic"
