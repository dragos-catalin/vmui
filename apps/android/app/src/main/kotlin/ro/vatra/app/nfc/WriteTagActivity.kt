package ro.vatra.app.nfc

import android.nfc.NdefMessage
import android.nfc.NdefRecord
import android.nfc.NfcAdapter
import android.nfc.Tag
import android.nfc.tech.Ndef
import android.nfc.tech.NdefFormatable
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.RadioButton
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import ro.vatra.app.R
import ro.vatra.app.VatraApp
import ro.vatra.core.action.QuickAction
import ro.vatra.core.net.ApiResult
import ro.vatra.ui.VatraTheme

/**
 * Writes a `vatra://do?…` action to an NFC tag. The tag holds no secret: tapping it opens Vatra,
 * which runs the action with the tapping phone's own token and room permissions.
 */
class WriteTagActivity : ComponentActivity(), NfcAdapter.ReaderCallback {
    private var selected by mutableStateOf<QuickAction>(QuickAction.Water)
    private var status by mutableStateOf<Int?>(null)
    private var scenes by mutableStateOf<List<Pair<String, String>>>(emptyList())

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContent {
            VatraTheme {
                LaunchedEffect(Unit) {
                    val l = VatraApp.from(this@WriteTagActivity).activeClient()?.lights()
                    scenes = (l as? ApiResult.Ok)?.value?.scenes?.map { it.id to it.name }.orEmpty()
                }
                val options = buildList {
                    add(QuickAction.Water to stringResource(R.string.water_drink))
                    add(QuickAction.Ambilight("movie") to stringResource(R.string.ambilight_movie))
                    add(QuickAction.Ambilight("off") to stringResource(R.string.ambilight_off))
                    add(QuickAction.Script("pc_wake") to stringResource(R.string.pc_wake))
                    scenes.forEach { (id, name) -> add(QuickAction.Scene(id) to name) }
                }
                Surface {
                    Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(24.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                        Text(stringResource(R.string.nfc_title), style = MaterialTheme.typography.headlineSmall)
                        options.forEach { (a, label) ->
                            Row(Modifier.fillMaxWidth().clickable(role = Role.RadioButton) { selected = a }.padding(4.dp), verticalAlignment = Alignment.CenterVertically) {
                                RadioButton(selected = selected == a, onClick = null)
                                Text(label, Modifier.padding(start = 8.dp))
                            }
                        }
                        Text(
                            stringResource(status ?: R.string.nfc_hold),
                            style = MaterialTheme.typography.titleMedium,
                            modifier = Modifier.padding(top = 16.dp).semantics { liveRegion = LiveRegionMode.Polite },
                        )
                    }
                }
            }
        }
    }

    override fun onResume() {
        super.onResume()
        NfcAdapter.getDefaultAdapter(this)?.enableReaderMode(this, this, NfcAdapter.FLAG_READER_NFC_A or NfcAdapter.FLAG_READER_NFC_B or NfcAdapter.FLAG_READER_NFC_F or NfcAdapter.FLAG_READER_NFC_V, null)
            ?: run { status = R.string.nfc_missing }
    }

    override fun onPause() {
        NfcAdapter.getDefaultAdapter(this)?.disableReaderMode(this)
        super.onPause()
    }

    override fun onTagDiscovered(tag: Tag) {
        val msg = NdefMessage(arrayOf(NdefRecord.createUri(selected.toUri()), NdefRecord.createApplicationRecord(packageName)))
        val ok = runCatching {
            Ndef.get(tag)?.use { n ->
                n.connect()
                check(n.isWritable && n.maxSize >= msg.byteArrayLength)
                n.writeNdefMessage(msg)
            } ?: NdefFormatable.get(tag)?.use { f ->
                f.connect()
                f.format(msg)
            } ?: error("not ndef")
        }.isSuccess
        runOnUiThread { status = if (ok) R.string.nfc_written else R.string.nfc_failed }
    }
}
