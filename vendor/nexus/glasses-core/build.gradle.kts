plugins {
    id("com.android.library")
}

android {
    namespace = "com.anezium.rokidbus.glasses"
    compileSdk = 36

    defaultConfig {
        minSdk = 31
    }

    buildFeatures {
        aidl = true
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
    implementation("com.google.android.flexbox:flexbox:3.0.0")
    implementation("com.airbnb.android:lottie:6.7.1")
    implementation("com.rokid.cxr:cxr-service-bridge:1.0-20260522.063600-105")
    implementation("dev.mobile:dadb:1.2.10")
    implementation(project(":kadb-compat"))
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-core:1.10.2")
    testImplementation("junit:junit:4.13.2")
    // Plain-JUnit ink tests exercise wire JSON against the real org.json, not the
    // throwing android.jar stubs — same arrangement as :shared.
    testImplementation("org.json:json:20240303")
    testImplementation("org.robolectric:robolectric:4.13")
}
