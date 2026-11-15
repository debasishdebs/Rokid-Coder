plugins {
    id("com.android.library")
}

android {
    namespace = "com.anezium.rokidbus.phone.core"
    compileSdk = 36

    defaultConfig {
        minSdk = 30
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_11
        targetCompatibility = JavaVersion.VERSION_11
    }
}

dependencies {
    api(project(":shared"))
    api(project(":bus-client"))
    implementation(project(":ink-engine"))
    implementation("androidx.annotation:annotation:1.8.1")
    implementation("com.example.cxrglobal:lib:0.3.0")
    implementation("com.android.tools.build:apksig:9.2.0")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-core:1.10.2")
    testImplementation("junit:junit:4.13.2")
    testImplementation("org.json:json:20240303")
    testImplementation("org.robolectric:robolectric:4.13")
    testImplementation("org.jetbrains.kotlinx:kotlinx-coroutines-test:1.10.2")
}
