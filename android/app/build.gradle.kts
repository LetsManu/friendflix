// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import app.friendflix.android.versionCode
import app.friendflix.android.versionFromJson

plugins {
    alias(libs.plugins.android.application)
}

// The app version is the server version: ../version.json is the single source of truth (release.mjs bumps it).
// versionName / versionCode are never edited by hand.
val versionJson = rootProject.file("../version.json")
val appVersion: String = versionFromJson(providers.fileContents(layout.file(provider { versionJson })).asText.get())

android {
    namespace = "app.friendflix.android"
    compileSdk = 36

    defaultConfig {
        applicationId = "app.friendflix.android"
        minSdk = 26
        targetSdk = 36
        versionName = appVersion
        versionCode = versionCode(appVersion)
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
    }

    buildTypes {
        release {
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

    // The version helpers live in buildSrc (used by this script) and are unit-tested from here.
    sourceSets.getByName("test").kotlin.directories.add("../buildSrc/src/main/kotlin")
}

dependencies {
    implementation(libs.androidx.core.ktx)
    implementation(libs.androidx.activity.ktx)
    implementation(libs.androidx.datastore.preferences)
    implementation(libs.androidx.webkit)
    implementation(libs.okhttp)
    implementation(libs.media3.datasource)
    implementation(libs.media3.datasource.okhttp)
    implementation(libs.media3.exoplayer)
    implementation(libs.media3.exoplayer.hls)
    implementation(libs.media3.ui)
    implementation(libs.media3.session)
    implementation(libs.androidx.work.runtime)

    testImplementation(libs.junit)
    testImplementation(libs.robolectric)
    testImplementation(libs.androidx.test.core)
    testImplementation(libs.okhttp.mockwebserver)
    testImplementation(libs.androidx.work.testing)
    testImplementation(libs.media3.test.utils)
    testImplementation(libs.media3.test.utils.robolectric)

    androidTestImplementation(libs.androidx.test.ext.junit)
    androidTestImplementation(libs.androidx.test.runner)
    androidTestImplementation(libs.androidx.test.core)
    androidTestImplementation(libs.androidx.test.espresso.intents)
}
