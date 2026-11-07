# kotlinx.serialization: keep generated serializers of the wire models.
-keepattributes *Annotation*, InnerClasses
-keepclassmembers class ro.vatra.** {
    *** Companion;
}
-keepclasseswithmembers class ro.vatra.** {
    kotlinx.serialization.KSerializer serializer(...);
}
-keep,includedescriptorclasses class ro.vatra.**$$serializer { *; }
