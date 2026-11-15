pluginManagement {
    includeBuild("build-logic")
    repositories {
        mavenLocal()
        google()
        mavenCentral()
        gradlePluginPortal()
    }
}

dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
    repositories {
        mavenLocal()
        google()
        mavenCentral()
        maven { url = uri("https://jitpack.io") }
        maven {
            url = uri("https://maven.pkg.github.com/MorpheApp/registry")
            // GitHub Packages rejects anonymous reads even of public packages. CI passes
            // GITHUB_ACTOR/GITHUB_TOKEN; developer machines may set gpr.user/gpr.key.
            val packagesUser = listOf(providers.environmentVariable("GITHUB_ACTOR"), providers.gradleProperty("gpr.user"))
                .firstNotNullOfOrNull { it.orNull?.takeIf(String::isNotBlank) }
            val packagesKey = listOf(providers.environmentVariable("GITHUB_TOKEN"), providers.gradleProperty("gpr.key"))
                .firstNotNullOfOrNull { it.orNull?.takeIf(String::isNotBlank) }
            if (packagesUser != null && packagesKey != null) {
                credentials {
                    username = packagesUser
                    password = packagesKey
                }
            }
            content {
                includeGroup("app.morphe")
            }
        }
        maven { url = uri("https://maven.rokid.com/repository/maven-public/") }
    }
}

rootProject.name = "RokidCoder"

// Upstream Nexus is vendored at vendor/nexus (a git subtree; see vendor/nexus/PATCHES.md).
// Its modules keep their upstream names so project paths and test identities stay stable.
for (name in listOf("shared", "bus-client", "ink-engine", "kadb-compat", "phone-hub", "glasses-hub")) {
    include(":$name")
    project(":$name").projectDir = file("vendor/nexus/$name")
}

// Registered once they exist, so later tasks add a module without touching this file.
val optionalModules = linkedMapOf(
    ":phone-core" to "vendor/nexus/phone-core",
    ":glasses-core" to "vendor/nexus/glasses-core",
    ":mobile:app" to "mobile/app",
    ":mobile:caller-test" to "mobile/caller-test",
    ":mobile:agents" to "mobile/agents",
    ":glasses-app" to "glasses/app",
)
for ((path, dir) in optionalModules) {
    if (file(dir).exists()) {
        include(path)
        project(path).projectDir = file(dir)
    }
}

// The CXR vendor library is the sibling checkout <repoRoot>/../CxrGlobal. vendor/CxrGlobal
// links to it, so the standalone vendor/nexus build finds it at its own ../CxrGlobal.
val cxrGlobalDirectory = rootDir.parentFile.resolve("CxrGlobal")
val skipCxrGlobal = providers.gradleProperty("skipCxrGlobal")
    .map(String::toBoolean)
    .orElse(false)
    .get()
if (!skipCxrGlobal && cxrGlobalDirectory.isDirectory) {
    includeBuild(cxrGlobalDirectory) {
        dependencySubstitution {
            substitute(module("com.example.cxrglobal:lib")).using(project(":lib"))
        }
    }
}
