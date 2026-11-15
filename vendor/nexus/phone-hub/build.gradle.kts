plugins {
    id("com.android.application")
}

apply(from = rootProject.file("gradle/plugin-release-signing.gradle"))

// Bootstrap provenance and fork/key-rotation instructions: docs/GLASSES_APK_VERIFICATION.md.
val glassesApkSignerSha256 = providers.gradleProperty("glassesApkSignerSha256")
    .getOrElse("f5e938e2e79b0526b31e40d36c8c19098450c1636b7e14a306681b4effddf81c")
require(glassesApkSignerSha256.split(',').all { it.matches(Regex("[0-9a-fA-F]{64}")) }) {
    "glassesApkSignerSha256 must contain a comma-separated list of 64-hex SHA-256 certificate digests, with no empty elements"
}

// This shell is upstream Nexus: it keeps upstream's phone id and drives upstream's glasses hub.
val glassesApplicationId = "com.anezium.rokidbus.glasses"

android {
    namespace = "com.anezium.rokidbus.phone"
    compileSdk = 36

    defaultConfig {
        applicationId = "com.anezium.rokidbus.phone"
        minSdk = 30
        targetSdk = 36
        versionCode = 10801
        versionName = "1.8.1"
        buildConfigField("String", "PHONE_APPLICATION_ID", "\"$applicationId\"")
        buildConfigField("String", "GLASSES_APPLICATION_ID", "\"$glassesApplicationId\"")
        buildConfigField("String", "GLASSES_APK_SIGNER_SHA256", "\"${glassesApkSignerSha256.lowercase()}\"")
    }

    buildFeatures {
        buildConfig = true
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

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_11
        targetCompatibility = JavaVersion.VERSION_11
    }

    packaging {
        resources {
            excludes += "META-INF/versions/**"
        }
    }
}

// The unit tests check the components this app ships against its merged manifest: Robolectric
// reads the real manifest only with Android resources included, which these suites predate.
androidComponents {
    onVariants { variant ->
        val mergedManifest = variant.artifacts.get(com.android.build.api.artifact.SingleArtifact.MERGED_MANIFEST)
        val testTaskName = "test${variant.name.replaceFirstChar(Char::uppercaseChar)}UnitTest"
        tasks.withType<Test>().matching { it.name == testTaskName }.configureEach {
            inputs.file(mergedManifest).withPathSensitivity(PathSensitivity.NONE)
            jvmArgumentProviders.add(
                CommandLineArgumentProvider {
                    listOf("-Drokid.mergedManifest=${mergedManifest.get().asFile.absolutePath}")
                },
            )
        }
    }
}

dependencies {
    implementation(project(":shared"))
    implementation(project(":bus-client"))
    implementation(project(":phone-core"))
    implementation(project(":ink-engine"))
    implementation("androidx.activity:activity:1.10.1")
    implementation("androidx.exifinterface:exifinterface:1.4.2")
    implementation("com.example.cxrglobal:lib:0.3.0")
    implementation(project(":kadb-compat"))
    implementation("com.android.tools.build:apksig:9.2.0")
    implementation("com.squareup.okhttp3:okhttp:4.12.0")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-core:1.10.2")
    testImplementation("junit:junit:4.13.2")
    testImplementation("org.json:json:20240303")
    testImplementation("org.robolectric:robolectric:4.13")
}
