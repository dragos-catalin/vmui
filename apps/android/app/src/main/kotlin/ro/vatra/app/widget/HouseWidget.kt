package ro.vatra.app.widget

import android.content.Context
import androidx.compose.ui.unit.dp
import androidx.glance.GlanceId
import androidx.glance.GlanceModifier
import androidx.glance.GlanceTheme
import androidx.glance.action.ActionParameters
import androidx.glance.action.actionParametersOf
import androidx.glance.action.clickable
import androidx.glance.appwidget.GlanceAppWidget
import androidx.glance.appwidget.GlanceAppWidgetReceiver
import androidx.glance.appwidget.action.ActionCallback
import androidx.glance.appwidget.action.actionRunCallback
import androidx.glance.appwidget.action.actionStartActivity
import androidx.glance.appwidget.cornerRadius
import androidx.glance.appwidget.provideContent
import androidx.glance.background
import androidx.glance.layout.Column
import androidx.glance.layout.Row
import androidx.glance.layout.Spacer
import androidx.glance.layout.fillMaxSize
import androidx.glance.layout.padding
import androidx.glance.layout.width
import androidx.glance.text.FontWeight
import androidx.glance.text.Text
import androidx.glance.text.TextStyle
import ro.vatra.app.MainActivity
import ro.vatra.app.R
import ro.vatra.app.VatraApp
import ro.vatra.core.action.QuickAction

/** Home screen widget: lights on, today's water, and two one-tap actions. Works offline from the last snapshot. */
class HouseWidget : GlanceAppWidget() {
    override suspend fun provideGlance(context: Context, id: GlanceId) {
        val home = VatraApp.from(context).hubs.current().active?.name.orEmpty()
        val s = WidgetSync.read(context, home)
        provideContent {
            GlanceTheme {
                Column(
                    GlanceModifier.fillMaxSize().background(GlanceTheme.colors.widgetBackground).cornerRadius(18.dp).padding(12.dp)
                        .clickable(actionStartActivity(android.content.Intent(context, MainActivity::class.java))),
                ) {
                    Text(s.home.ifEmpty { context.getString(R.string.app_name) }, style = TextStyle(fontWeight = FontWeight.Bold, color = GlanceTheme.colors.onSurface))
                    Text(context.getString(R.string.widget_lights, s.lightsOn), style = TextStyle(color = GlanceTheme.colors.onSurfaceVariant))
                    if (s.waterTarget > 0) Text(context.getString(R.string.water_progress, s.waterMl, s.waterTarget), style = TextStyle(color = GlanceTheme.colors.onSurfaceVariant))
                    Spacer(GlanceModifier.padding(top = 6.dp))
                    Row {
                        Text(
                            context.getString(R.string.water_drink),
                            modifier = GlanceModifier.background(GlanceTheme.colors.primary).cornerRadius(12.dp).padding(8.dp)
                                .clickable(actionRunCallback<RunQuick>(actionParametersOf(RunQuick.KEY to QuickAction.Water.toUri()))),
                            style = TextStyle(color = GlanceTheme.colors.onPrimary),
                        )
                        Spacer(GlanceModifier.width(8.dp))
                        Text(
                            context.getString(R.string.ambilight_off),
                            modifier = GlanceModifier.background(GlanceTheme.colors.secondaryContainer).cornerRadius(12.dp).padding(8.dp)
                                .clickable(actionRunCallback<RunQuick>(actionParametersOf(RunQuick.KEY to QuickAction.Ambilight("off").toUri()))),
                            style = TextStyle(color = GlanceTheme.colors.onSecondaryContainer),
                        )
                    }
                }
            }
        }
    }
}

class RunQuick : ActionCallback {
    override suspend fun onAction(context: Context, glanceId: GlanceId, parameters: ActionParameters) {
        val a = parameters[KEY]?.let(QuickAction::parse) ?: return
        VatraApp.from(context).activeClient()?.let { a.run(it) }
    }

    companion object {
        val KEY = ActionParameters.Key<String>("quick")
    }
}

class HouseWidgetReceiver : GlanceAppWidgetReceiver() {
    override val glanceAppWidget: GlanceAppWidget = HouseWidget()
}
