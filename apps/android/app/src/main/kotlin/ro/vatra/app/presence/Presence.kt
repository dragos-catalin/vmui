package ro.vatra.app.presence

import android.Manifest
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.location.LocationManager
import androidx.core.content.ContextCompat
import kotlinx.coroutines.launch
import ro.vatra.app.VatraApp

/**
 * Arrive / leave home without Google Play services: the framework proximity alert (LocationManager),
 * so the FOSS build has it too. The home point is where the phone is when the member turns it on
 * (they are at home then); only a "home" / "away" event leaves the phone, never coordinates.
 */
object Presence {
    const val available = true
    private const val RADIUS_M = 150f
    private const val PREFS = "vatra_presence"

    private fun pending(c: Context) = PendingIntent.getBroadcast(
        c, 7, Intent(c, PresenceReceiver::class.java), PendingIntent.FLAG_MUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
    )

    fun hasPermission(c: Context): Boolean =
        ContextCompat.checkSelfPermission(c, Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED &&
            ContextCompat.checkSelfPermission(c, Manifest.permission.ACCESS_BACKGROUND_LOCATION) == PackageManager.PERMISSION_GRANTED

    /** Returns false when location permission (incl. "all the time") is missing; Settings shows why. */
    suspend fun setEnabled(c: Context, on: Boolean): Boolean {
        val app = VatraApp.from(c)
        val lm = c.getSystemService(LocationManager::class.java)
        if (!on) {
            runCatching { lm.removeProximityAlert(pending(c)) }
            app.prefs.setGeofence(false)
            return true
        }
        if (!hasPermission(c)) {
            c.startActivity(Intent(c, PermissionActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
            return false
        }
        @Suppress("MissingPermission")
        val here = lm.getLastKnownLocation(LocationManager.FUSED_PROVIDER) ?: lm.getLastKnownLocation(LocationManager.GPS_PROVIDER) ?: lm.getLastKnownLocation(LocationManager.NETWORK_PROVIDER)
            ?: return false
        c.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putFloat("lat", here.latitude.toFloat()).putFloat("lon", here.longitude.toFloat()).apply()
        @Suppress("MissingPermission")
        lm.addProximityAlert(here.latitude, here.longitude, RADIUS_M, -1, pending(c))
        app.prefs.setGeofence(true)
        return true
    }
}

class PresenceReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (!intent.hasExtra(LocationManager.KEY_PROXIMITY_ENTERING)) return
        val state = if (intent.getBooleanExtra(LocationManager.KEY_PROXIMITY_ENTERING, false)) "home" else "away"
        val app = VatraApp.from(context)
        val pending = goAsync()
        app.scope.launch {
            try {
                app.activeClient()?.presence(state, "geofence")
            } finally {
                pending.finish()
            }
        }
    }
}
