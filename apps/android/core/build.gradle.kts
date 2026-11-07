plugins {
    alias(libs.plugins.android.library)
    alias(libs.plugins.kotlin.serialization)
}

android {
    namespace = "ro.vatra.core"
    compileSdk = 37

    defaultConfig { minSdk = 29 }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    testOptions { unitTests.isReturnDefaultValues = true }
}

// The hub's contract fixtures ARE the test data: a route change the app does not follow fails here.
val fixtures = rootProject.layout.projectDirectory.dir("../../docs/api/fixtures")
tasks.withType<Test>().configureEach {
    inputs.dir(fixtures).withPropertyName("contractFixtures")
    systemProperty("vatra.fixtures", fixtures.asFile.absolutePath)
}

kotlin {
    compilerOptions { allWarningsAsErrors.set(true) }
}

dependencies {
    api(libs.coroutines.android)
    api(libs.serialization.json)
    api(libs.okhttp)
    implementation(libs.datastore.preferences)

    testImplementation(libs.junit)
    testImplementation(libs.coroutines.test)
    testImplementation(libs.okhttp.mockwebserver)
}
