plugins {
    id("com.android.application")
}

apply(from = rootProject.file("gradle/plugin-release-signing.gradle"))

android {
    // The core keeps com.anezium.rokidbus.glasses, so its R and relative component names hold.
    namespace = "com.anezium.rokidbus.glasses.shell"
    compileSdk = 36

    defaultConfig {
        applicationId = "com.anezium.rokidbus.glasses"
        minSdk = 31
        targetSdk = 32
        versionCode = 10801
        versionName = "1.8.1"
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            proguardFiles(
                getDefaultProguardFile("proguard-android-optimize.txt"),
                "proguard-rules.pro",
            )
        }
    }

    sourceSets["main"].manifest.srcFile("src/shell/AndroidManifest.xml")

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_11
        targetCompatibility = JavaVersion.VERSION_11
    }

    lint {
        // YodaOS side-load compatibility intentionally keeps this glasses app on API 32.
        disable += "ExpiredTargetSdkVersion"
    }
}

dependencies {
    implementation(project(":glasses-core"))
}
