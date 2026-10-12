plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

// FCM (wake-on-offline) is optional: the Google Services plugin is applied only
// when the Firebase config file exists. Add Android-App/app/google-services.json
// from the Firebase console and rebuild to activate FCM; without it the app
// builds and runs exactly as before.
if (file("google-services.json").exists()) {
    apply(plugin = "com.google.gms.google-services")
}

android {
    namespace = "com.customersupport"
    compileSdk = 34

    signingConfigs {
        create("release") {
            storeFile = file("my-release-key.keystore")
            storePassword = "CustomerSupport2025"
            keyAlias = "customersupport"
            keyPassword = "CustomerSupport2025"
        }
    }

    defaultConfig {
        applicationId = "com.customersupport"
        minSdk = 24
        targetSdk = 34
        versionCode = 1
        versionName = "1.0"

        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
    }

    buildTypes {
        release {
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(
                getDefaultProguardFile("proguard-android-optimize.txt"),
                "proguard-rules.pro"
            )
            signingConfig = signingConfigs.getByName("release")
        }
    }
    kotlinOptions {
        jvmTarget = "1.8"
    }
    buildFeatures {
        viewBinding = true
    }
    packaging {
        resources {
            excludes += "/META-INF/{AL2.0,LGPL2.1}"
        }
    }
}

dependencies {
    // Core Android (minimal)
    implementation("androidx.core:core-ktx:1.12.0")
    implementation("androidx.appcompat:appcompat:1.6.1")
    implementation("androidx.lifecycle:lifecycle-runtime-ktx:2.6.2")

    // Socket.IO for sync
    implementation("io.socket:socket.io-client:2.1.0") {
        exclude(group = "org.json", module = "json")
    }

    // Firebase Cloud Messaging — high-priority wake-up messages (wake-on-offline).
    // Dormant until google-services.json is added; the BOM is pinned to a version
    // compatible with compileSdk 34 / AGP 8.2.
    implementation(platform("com.google.firebase:firebase-bom:33.7.0"))
    implementation("com.google.firebase:firebase-messaging")

    // DataStore for preferences
    implementation("androidx.datastore:datastore-preferences:1.0.0")

    // Coroutines
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.7.3")

    // WorkManager for persistent periodic sync
    implementation("androidx.work:work-runtime-ktx:2.9.0")
}
