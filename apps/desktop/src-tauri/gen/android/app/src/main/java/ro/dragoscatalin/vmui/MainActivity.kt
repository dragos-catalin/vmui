package ro.dragoscatalin.vmui

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import androidx.activity.enableEdgeToEdge
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat
import com.google.firebase.messaging.FirebaseMessaging
import java.io.File

class MainActivity : TauriActivity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
    Notifier.ensureChannels(this)
    handleLink(intent)
  }

  override fun onNewIntent(intent: Intent) {
    super.onNewIntent(intent)
    handleLink(intent)
  }

  override fun onResume() {
    super.onResume()
    // Only once paired: the token is stored against the paired_devices row on the Pi.
    if (Vmui.conn(this) == null) return
    if (Build.VERSION.SDK_INT >= 33 && ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
      ActivityCompat.requestPermissions(this, arrayOf(Manifest.permission.POST_NOTIFICATIONS), 41)
    }
    try {
      FirebaseMessaging.getInstance().token.addOnSuccessListener { t -> Vmui.registerPush(this, t) }
    } catch (_: Exception) {
      // no google-services.json in this build → SSE only while the app is open
    }
  }

  /** vmui://<route>[/<id>] → written for the Rust side (`pending_link` command); the webview picks it up on focus. */
  private fun handleLink(i: Intent?) {
    val d = i?.data ?: return
    if (d.scheme != "vmui") return
    File(dataDir, "pending-link.txt").writeText(d.toString())
    val id = d.pathSegments.firstOrNull()
    if (d.host == "notifications" && id != null) Notifier.cancel(this, id, d.getQueryParameter("tag"))
  }
}
