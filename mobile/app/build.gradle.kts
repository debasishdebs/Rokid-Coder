plugins {
    id("com.android.application")
    // AGP 9.2.0 compiles Kotlin with its built-in KGP 2.2.10 (see :buildEnvironment); the Compose compiler must match.
    id("org.jetbrains.kotlin.plugin.compose") version "2.2.10"
}

apply(from = rootProject.file("gradle/plugin-release-signing.gradle"))

android {
    // The Kotlin namespace stays com.anezium.rokidbus.*, so R, BuildConfig and every test identity are unchanged.
    namespace = "com.anezium.rokidbus.plugin.agents"
    compileSdk = 36

    defaultConfig {
        applicationId = "io.github.debasishdebs.rokidcoder"
        minSdk = 30
        targetSdk = 36
        versionCode = 800
        versionName = "0.8.0"
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
    }

    buildFeatures {
        buildConfig = true
        compose = true
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_11
        targetCompatibility = JavaVersion.VERSION_11
    }
}

dependencies {
    implementation(project(":phone-core"))
    implementation("androidx.core:core:1.13.1")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.10.2")
    implementation("com.squareup.okhttp3:okhttp:4.12.0")

    // Phone screens only: the PCA light mint theme and settings widgets (R31).
    implementation(platform("androidx.compose:compose-bom:2024.09.00"))
    implementation("androidx.compose.material3:material3")
    implementation("androidx.activity:activity-compose:1.9.2")
    implementation("androidx.lifecycle:lifecycle-runtime-compose:2.8.5")

    testImplementation("junit:junit:4.13.2")
    testImplementation("org.jetbrains.kotlinx:kotlinx-coroutines-test:1.10.2")
    testImplementation("org.json:json:20240303")
    testImplementation("org.robolectric:robolectric:4.13")
    // A local TLS agentd for the pinned wss client, with a cert that names no host.
    testImplementation("com.squareup.okhttp3:mockwebserver:4.12.0")
    testImplementation("com.squareup.okhttp3:okhttp-tls:4.12.0")
}
