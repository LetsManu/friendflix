// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
// The Fire TV app (com.friendflix.firetv): a server address screen, then the server's TV interface in a WebView.
// No Google Play services, no media3, no Cast, no WorkManager: Fire OS has no Play services.
import app.friendflix.android.versionCode
import app.friendflix.android.versionFromJson

plugins {
    alias(libs.plugins.android.application)
}

// The app version is the server version: ../version.json is the single source of truth (release.mjs bumps it).
val versionJson = rootProject.file("../version.json")
val appVersion: String = versionFromJson(providers.fileContents(layout.file(provider { versionJson })).asText.get())

android {
    namespace = "app.friendflix.firetv"
    compileSdk = 37

    defaultConfig {
        applicationId = "com.friendflix.firetv"
        // Fire OS 7 (Android 9) and newer
        minSdk = 28
        targetSdk = 36
        versionName = appVersion
        versionCode = versionCode(appVersion)
    }

    // Release signing with the phone app's upload key, only when the release workflow provides it (env vars, never a file in the repo):
    // ANDROID_UPLOAD_KEYSTORE_FILE (path of the decoded keystore), ANDROID_UPLOAD_KEY_PASSWORD (store and key), ANDROID_UPLOAD_KEY_ALIAS.
    // Without them release builds stay unsigned (PR CI, local builds); debug builds always use the debug key.
    val uploadKeystore = providers.environmentVariable("ANDROID_UPLOAD_KEYSTORE_FILE").orNull?.takeIf { it.isNotBlank() }
    val uploadPassword = providers.environmentVariable("ANDROID_UPLOAD_KEY_PASSWORD").orNull?.takeIf { it.isNotEmpty() }
    val uploadAlias = providers.environmentVariable("ANDROID_UPLOAD_KEY_ALIAS").orNull?.takeIf { it.isNotBlank() }
    val upload = if (uploadKeystore != null && uploadPassword != null && uploadAlias != null) {
        signingConfigs.create("upload") {
            storeFile = file(uploadKeystore)
            storePassword = uploadPassword
            keyAlias = uploadAlias
            keyPassword = uploadPassword
        }
    } else {
        null
    }

    buildTypes {
        release {
            if (upload != null) signingConfig = upload
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    buildFeatures {
        buildConfig = true
    }

    lint {
        warningsAsErrors = true
        abortOnError = true
        checkDependencies = true
        // "newer version available" checks are Dependabot's job (a lint error would break CI whenever Google releases something).
        disable += setOf("OldTargetApi", "AndroidGradlePluginVersion", "GradleDependency", "NewerVersionAvailable")
    }

    testOptions.unitTests.isIncludeAndroidResources = true
}

dependencies {
    implementation(project(":shell-core"))
    implementation(libs.androidx.core.ktx)
    implementation(libs.androidx.activity.ktx)
    implementation(libs.androidx.webkit)
    implementation(libs.androidx.datastore.preferences)
    implementation(libs.okhttp)

    testImplementation(libs.junit)
    testImplementation(libs.robolectric)
    testImplementation(libs.androidx.test.core)
}

tasks.withType<Test>().configureEach {
    // Robolectric 4.17 sets up Android 36's ApplicationSharedMemory through FileDescriptor internals
    // (jdk.internal.access.SharedSecrets), which Java 21 only allows when java.base exports them to the test classpath.
    jvmArgs("--add-opens=java.base/java.io=ALL-UNNAMED", "--add-exports=java.base/jdk.internal.access=ALL-UNNAMED")
    // Full stack traces in the CI log: a failing unit test shows its cause without the HTML report.
    testLogging { exceptionFormat = org.gradle.api.tasks.testing.logging.TestExceptionFormat.FULL }
}
