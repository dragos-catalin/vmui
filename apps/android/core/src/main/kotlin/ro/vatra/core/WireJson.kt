package ro.vatra.core

import kotlinx.serialization.json.Json

/** One Json for the whole app: tolerant of new fields, `type`/`op` discriminators as the hub uses them. */
val WireJson: Json = Json {
    ignoreUnknownKeys = true
    explicitNulls = false
    encodeDefaults = true
    isLenient = false
}

/** Discriminator per sealed request family (control uses "type", lights/notify use "op", push uses "kind"). */
val ControlJson: Json = Json(WireJson) { classDiscriminator = "type" }
val OpJson: Json = Json(WireJson) { classDiscriminator = "op" }
val KindJson: Json = Json(WireJson) { classDiscriminator = "kind" }
