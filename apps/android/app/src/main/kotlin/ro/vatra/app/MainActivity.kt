package ro.vatra.app

import android.content.Intent
import android.nfc.NfcAdapter
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.viewModels
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.core.splashscreen.SplashScreen.Companion.installSplashScreen
import androidx.lifecycle.lifecycleScope
import kotlinx.coroutines.launch
import ro.vatra.app.ui.HomeModel
import ro.vatra.app.ui.VatraRoot
import ro.vatra.core.action.QuickAction
import ro.vatra.core.pairing.PairLink
import ro.vatra.ui.VatraTheme

/**
 * One activity. Deep links: `vatra://pair?…` (QR scanned by the system camera, or the hub's link)
 * opens the add-hub flow with the invite filled in; `vatra://do?…` (an NFC tag, a shortcut) runs that
 * house action through the active hub with this phone's own permissions.
 */
class MainActivity : ComponentActivity() {
    private val model: HomeModel by viewModels()
    private var pendingInvite by mutableStateOf<PairLink?>(null)

    override fun onCreate(savedInstanceState: Bundle?) {
        installSplashScreen()
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        handle(intent)
        setContent {
            VatraTheme {
                VatraRoot(model = model, invite = pendingInvite, onInviteUsed = { pendingInvite = null })
            }
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        handle(intent)
    }

    override fun onStart() {
        super.onStart()
        model.restart()
    }

    override fun onStop() {
        model.stop()
        super.onStop()
    }

    private fun handle(i: Intent?) {
        val raw = i?.dataString ?: ndefUri(i) ?: return
        PairLink.parse(raw)?.let {
            pendingInvite = it
            return
        }
        QuickAction.parse(raw)?.let { a -> lifecycleScope.launch { model.quick(a) } }
    }

    /** NFC tags written by the app carry a single URI record; Android also puts it in data, but not on every OEM. */
    private fun ndefUri(i: Intent?): String? {
        if (i?.action != NfcAdapter.ACTION_NDEF_DISCOVERED) return null
        val msgs = androidx.core.content.IntentCompat.getParcelableArrayExtra(i, NfcAdapter.EXTRA_NDEF_MESSAGES, android.nfc.NdefMessage::class.java)
        return msgs?.filterIsInstance<android.nfc.NdefMessage>()?.firstOrNull()?.records?.firstOrNull()?.toUri()?.toString()
    }
}
