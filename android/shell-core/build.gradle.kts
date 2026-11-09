// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
// The shell classes shared by the phone app (:app) and the Fire TV app: origin policy, server address, watch links, the WebView
// client and the server probe. No resources, no Play services.
plugins {
    alias(libs.plugins.android.library)
}

android {
    namespace = "app.friendflix.android.core"
    compileSdk = 37

    defaultConfig {
        minSdk = 26
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
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
    // HttpUrl is part of the public API (OriginPolicy, ServerAddress, ServerProbe).
    api(libs.okhttp)
    implementation(libs.androidx.core.ktx)
    implementation(libs.androidx.webkit)
}
