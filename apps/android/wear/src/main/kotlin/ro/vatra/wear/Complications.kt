package ro.vatra.wear

import android.app.PendingIntent
import android.content.Intent
import androidx.wear.watchface.complications.data.ComplicationData
import androidx.wear.watchface.complications.data.ComplicationType
import androidx.wear.watchface.complications.data.NoDataComplicationData
import androidx.wear.watchface.complications.data.PlainComplicationText
import androidx.wear.watchface.complications.data.RangedValueComplicationData
import androidx.wear.watchface.complications.data.ShortTextComplicationData
import androidx.wear.watchface.complications.datasource.ComplicationRequest
import androidx.wear.watchface.complications.datasource.SuspendingComplicationDataSourceService

private fun SuspendingComplicationDataSourceService.openApp(): PendingIntent =
    PendingIntent.getActivity(this, 0, Intent(this, MainActivity::class.java), PendingIntent.FLAG_IMMUTABLE)

/** Today's water as a ring (ml of target). */
class WaterComplicationService : SuspendingComplicationDataSourceService() {
    override suspend fun onComplicationRequest(request: ComplicationRequest): ComplicationData? {
        val w = WearApp.from(this).glance()?.water ?: return NoDataComplicationData()
        return build(request.complicationType, w.ml, w.target)
    }

    override fun getPreviewData(type: ComplicationType): ComplicationData? = build(type, 1250, 2500)

    private fun build(type: ComplicationType, ml: Int, target: Int): ComplicationData? {
        val text = PlainComplicationText.Builder("${ml / 100 / 10.0}L").build()
        val spoken = PlainComplicationText.Builder(getString(R.string.water_short, ml, target)).build()
        return when (type) {
            ComplicationType.RANGED_VALUE -> RangedValueComplicationData.Builder(ml.toFloat().coerceAtMost(target.toFloat()), 0f, target.toFloat().coerceAtLeast(1f), spoken)
                .setText(text).setTapAction(openApp()).build()
            ComplicationType.SHORT_TEXT -> ShortTextComplicationData.Builder(text, spoken).setTapAction(openApp()).build()
            else -> null
        }
    }
}

/** How many lights are on in the rooms this member sees. */
class LightsComplicationService : SuspendingComplicationDataSourceService() {
    override suspend fun onComplicationRequest(request: ComplicationRequest): ComplicationData? {
        val n = WearApp.from(this).glance()?.lightsOn ?: return NoDataComplicationData()
        return build(request.complicationType, n)
    }

    override fun getPreviewData(type: ComplicationType): ComplicationData? = build(type, 3)

    private fun build(type: ComplicationType, n: Int): ComplicationData? {
        if (type != ComplicationType.SHORT_TEXT) return null
        return ShortTextComplicationData.Builder(PlainComplicationText.Builder(n.toString()).build(), PlainComplicationText.Builder(getString(R.string.lights_on, n)).build())
            .setTitle(PlainComplicationText.Builder(getString(R.string.lights_short)).build())
            .setTapAction(openApp())
            .build()
    }
}
