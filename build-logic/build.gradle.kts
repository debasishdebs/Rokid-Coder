plugins {
    `kotlin-dsl`
}

group = "io.github.debasishdebs.rokidcoder.gradle"

dependencies {
    // The plugin wires into the app's variants; the app build supplies AGP itself at runtime.
    compileOnly("com.android.tools.build:gradle-api:9.2.0")
    // The same apksig the phone core verifies with (vendor/nexus/phone-core/build.gradle.kts).
    implementation("com.android.tools.build:apksig:9.2.0")

    testImplementation("junit:junit:4.13.2")
    testImplementation(gradleTestKit())
}

gradlePlugin {
    plugins {
        register("glassesAsset") {
            id = "rokid.glasses-asset"
            implementationClass = "io.github.debasishdebs.rokidcoder.gradle.GlassesAssetPlugin"
        }
    }
}

tasks.test {
    // TestKit builds run in their own daemon; keep it small on a small machine.
    maxHeapSize = "512m"
    systemProperty("fixtureApk", layout.projectDirectory.file("src/test/resources/glasses-fixture-unsigned.apk").asFile.absolutePath)
}
