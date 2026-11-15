plugins {
    id("com.android.application") version "9.2.0" apply false
    id("com.android.library") version "9.2.0" apply false
}

// A test that blocks forever fails its task after 20 minutes instead of holding the build until CI cancels it.
subprojects {
    tasks.withType<Test>().configureEach {
        timeout.set(java.time.Duration.ofMinutes(20))
    }
}

tasks.register("clean", Delete::class) {
    delete(rootProject.layout.buildDirectory)
}
