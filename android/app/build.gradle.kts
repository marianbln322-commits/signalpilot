plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "ro.signalpilot.android"
    compileSdk = 35

    defaultConfig {
        applicationId = "ro.signalpilot.android"
        minSdk = 26
        targetSdk = 35
        versionCode = 1
        versionName = "1.0.0-original"
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions { jvmTarget = "17" }
}

dependencies {
    // Intentionally Android-SDK-only: no analytics, trackers or third-party runtime.
}
