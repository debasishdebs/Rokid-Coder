plugins {
    id("com.android.application")
    // The same pinned NEXUS_RELEASE_* key as the phone app: one key signs both.
    id("rokid.release-signing")
}

// Rokid Coder's pair, shared with the phone app (gradle.properties).
val phoneApplicationId = providers.gradleProperty("rokid.phoneApplicationId").get()
val glassesApplicationId = providers.gradleProperty("rokid.glassesApplicationId").get()

// The phone reads the glasses app's version from its versionName as major * 10000 + minor * 100
// + patch (R205), so the versionCode derived from the name must be the release's rokid.versionCode.
val glassesVersionName = providers.gradleProperty("rokid.versionName").get()
val glassesVersionCode = glassesVersionName.split('.').map(String::toInt).let { parts ->
    require(parts.size == 3 && parts[1] in 0..99 && parts[2] in 0..99) { "versionName must be major.minor.patch" }
    parts[0] * 10000 + parts[1] * 100 + parts[2]
}.also { derived ->
    val released = providers.gradleProperty("rokid.versionCode").get().toInt()
    require(derived == released) { "rokid.versionCode is $released, but rokid.versionName $glassesVersionName reads as $derived" }
}

android {
    // The core keeps com.anezium.rokidbus.glasses, so its R and relative component names hold.
    namespace = "com.anezium.rokidbus.glasses.app"
    compileSdk = 36

    defaultConfig {
        applicationId = glassesApplicationId
        minSdk = 31
        targetSdk = 32
        versionCode = glassesVersionCode
        versionName = glassesVersionName
        buildConfigField("String", "PHONE_APPLICATION_ID", "\"$phoneApplicationId\"")
        buildConfigField("String", "GLASSES_APPLICATION_ID", "\"$glassesApplicationId\"")
    }

    buildFeatures {
        buildConfig = true
    }

    buildTypes {
        release {
            isMinifyEnabled = false
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_11
        targetCompatibility = JavaVersion.VERSION_11
    }

    // Robolectric resolves the merged manifest's components under this app's id.
    testOptions.unitTests.isIncludeAndroidResources = true

    lint {
        // YodaOS side-load compatibility keeps the glasses app on API 32, as the upstream hub.
        disable += "ExpiredTargetSdkVersion"
    }
}

// The phone app bundles this app (rokid.glasses-asset): each build type's APK directory goes out on
// one consumable configuration, told apart by the build type, so the phone resolves the one it needs.
val glassesBuildType = Attribute.of("rokid.glassesBuildType", String::class.java)
val glassesApk = configurations.consumable("glassesApk")
androidComponents {
    onVariants { variant ->
        glassesApk.get().outgoing.variants.create(variant.name) {
            attributes.attribute(glassesBuildType, variant.buildType ?: variant.name)
            artifact(variant.artifacts.get(com.android.build.api.artifact.SingleArtifact.APK)) { type = "directory" }
        }
    }
}

dependencies {
    implementation(project(":glasses-core"))
    testImplementation("junit:junit:4.13.2")
    testImplementation("org.robolectric:robolectric:4.13")
}
