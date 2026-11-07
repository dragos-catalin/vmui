package ro.vatra.app

import android.content.Context
import androidx.datastore.preferences.core.booleanPreferencesKey
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.stringPreferencesKey
import androidx.datastore.preferences.preferencesDataStore
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.map

private val Context.appPrefs by preferencesDataStore(name = "vatra_prefs")

/** Non-secret preferences: push method, geofence on/off, the QS tile's action. */
class AppPrefs(private val context: Context) {
    private val pushMethod = stringPreferencesKey("push.method")
    private val geofence = booleanPreferencesKey("presence.geofence")
    private val tileAction = stringPreferencesKey("tile.action")
    private val fcmId = stringPreferencesKey("push.fcm.fid")

    /** "fcm" | "unifiedpush" | "none"; null = choose automatically (FCM when the hub offers it). */
    val push: Flow<String?> = context.appPrefs.data.map { it[pushMethod] }
    val geofenceOn: Flow<Boolean> = context.appPrefs.data.map { it[geofence] ?: false }
    val tile: Flow<String?> = context.appPrefs.data.map { it[tileAction] }

    suspend fun setPush(v: String?) = context.appPrefs.edit { if (v == null) it.remove(pushMethod) else it[pushMethod] = v }
    suspend fun setGeofence(v: Boolean) = context.appPrefs.edit { it[geofence] = v }
    suspend fun setTile(v: String) = context.appPrefs.edit { it[tileAction] = v }
    suspend fun pushNow(): String? = push.first()
    suspend fun tileNow(): String? = tile.first()

    /** Last Firebase installation ID (not a secret: useless without the project's server key). */
    suspend fun setFcmId(v: String) = context.appPrefs.edit { it[fcmId] = v }
    suspend fun fcmIdNow(): String? = context.appPrefs.data.first()[fcmId]
}
