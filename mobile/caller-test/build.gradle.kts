plugins {
    id("com.android.application")
}

// The app this one must not reach: the phone app's id, from gradle.properties.
val phoneApplicationId = providers.gradleProperty("rokid.phoneApplicationId").get()

// An unrelated app: its own id, and a throwaway test key that is neither the phone app's debug
// key nor its release key. Its instrumented test runs in this app's own process, so every call it
// makes comes from a stranger's UID.
android {
    namespace = "com.anezium.rokidbus.callertest"
    compileSdk = 36

    defaultConfig {
        applicationId = "com.anezium.rokidbus.callertest"
        minSdk = 30
        targetSdk = 36
        versionCode = 1
        versionName = "1.0"
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
        manifestPlaceholders["targetPackage"] = phoneApplicationId
        buildConfigField("String", "TARGET_PACKAGE", "\"$phoneApplicationId\"")
    }

    signingConfigs {
        create("unrelated") {
            storeFile = file("unrelated-caller.p12")
            storeType = "PKCS12"
            storePassword = "unrelated-caller"
            keyAlias = "unrelated"
            keyPassword = "unrelated-caller"
        }
    }

    buildTypes {
        getByName("debug") {
            signingConfig = signingConfigs.getByName("unrelated")
        }
    }

    buildFeatures {
        buildConfig = true
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_11
        targetCompatibility = JavaVersion.VERSION_11
    }
}

// Run in one invocation with the phone app's install, the test must see the build just installed.
tasks.matching { it.name == "connectedDebugAndroidTest" }.configureEach {
    mustRunAfter(":mobile:app:installDebug")
}

dependencies {
    androidTestImplementation("androidx.test:runner:1.6.2")
    androidTestImplementation("androidx.test.ext:junit:1.2.1")
    androidTestImplementation("junit:junit:4.13.2")
}
