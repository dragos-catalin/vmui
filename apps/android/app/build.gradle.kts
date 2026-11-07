plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.compose)
    alias(libs.plugins.kotlin.serialization)
}

// Release signing only from the environment (CI secrets); without it the release build is unsigned.
val keystorePath: String? = System.getenv("ANDROID_KEYSTORE_PATH")

android {
    namespace = "ro.vatra.app"
    compileSdk = 37

    defaultConfig {
        // Shared with :wear (the Data Layer only connects apps with one id + signing key)
        // and :tv (another artefact of the same Play listing).
        applicationId = "ro.vatra.app"
        minSdk = 29
        targetSdk = 36
        versionCode = System.getenv("VATRA_VERSION_CODE")?.toIntOrNull() ?: 1
        versionName = System.getenv("VATRA_VERSION") ?: "0.0.0-dev"
    }

    signingConfigs {
        if (keystorePath != null) {
            create("release") {
                storeFile = file(keystorePath)
                storePassword = System.getenv("ANDROID_KEYSTORE_PASSWORD")
                keyAlias = System.getenv("ANDROID_KEY_ALIAS")
                keyPassword = System.getenv("ANDROID_KEY_PASSWORD")
            }
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
            if (keystorePath != null) signingConfig = signingConfigs.getByName("release")
        }
    }

    // `play`: Google Play build, woken by FCM (Firebase options come from the hub at runtime,
    // no google-services.json) with UnifiedPush as the alternative, plus the Wear OS bridge.
    // `foss`: no Google Play services at all (F-Droid / GrapheneOS), UnifiedPush only.
    flavorDimensions += "store"
    productFlavors {
        create("play") { dimension = "store" }
        create("foss") {
            dimension = "store"
            versionNameSuffix = "-foss"
        }
    }

    buildFeatures {
        compose = true
        buildConfig = true
    }

    // A string missing from values-ro ships English to Romanian users: fail the build instead.
    lint { error += "MissingTranslation" }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    testOptions { unitTests.isReturnDefaultValues = true }
}

kotlin {
    compilerOptions { allWarningsAsErrors.set(true) }
}

dependencies {
    implementation(project(":core"))
    implementation(project(":ui"))

    implementation(platform(libs.compose.bom))
    implementation(libs.compose.ui)
    implementation(libs.compose.foundation)
    implementation(libs.compose.animation)
    implementation(libs.compose.material3)
    implementation(libs.compose.material.icons)
    implementation(libs.compose.ui.tooling.preview)
    debugImplementation(libs.compose.ui.tooling)

    implementation(libs.activity.compose)
    implementation(libs.core.ktx)
    implementation(libs.core.splashscreen)
    implementation(libs.lifecycle.runtime.compose)
    implementation(libs.lifecycle.viewmodel.compose)
    implementation(libs.lifecycle.process)
    implementation(libs.datastore.preferences)
    implementation(libs.work.runtime)
    implementation(libs.glance.appwidget)
    implementation(libs.glance.material3)

    implementation(libs.camerax.camera2)
    implementation(libs.camerax.lifecycle)
    implementation(libs.camerax.compose)
    implementation(libs.mlkit.barcode)

    implementation(libs.unifiedpush)
    implementation(libs.coroutines.jdk9)

    "playImplementation"(libs.firebase.messaging)
    "playImplementation"(libs.play.wearable)
    "playImplementation"(libs.coroutines.play.services)

    testImplementation(libs.junit)
}
