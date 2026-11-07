// AGP 9 compiles Kotlin itself; the Kotlin Gradle plugin is put on the
// classpath at the catalogue version so the compiler, the Compose compiler
// plugin and the serialization plugin agree (same setup as E:\gh\vitals).
buildscript {
    dependencies {
        classpath("org.jetbrains.kotlin:kotlin-gradle-plugin:${libs.versions.kotlin.get()}")
    }
}

plugins {
    alias(libs.plugins.android.application) apply false
    alias(libs.plugins.android.library) apply false
    alias(libs.plugins.kotlin.compose) apply false
    alias(libs.plugins.kotlin.serialization) apply false
}
