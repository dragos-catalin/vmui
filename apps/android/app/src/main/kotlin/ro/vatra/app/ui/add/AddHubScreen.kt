package ro.vatra.app.ui.add

import android.Manifest
import android.content.pm.PackageManager
import android.os.Build
import android.provider.Settings
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ListItem
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import androidx.core.content.ContextCompat
import kotlinx.coroutines.launch
import ro.vatra.app.R
import ro.vatra.app.VatraApp
import ro.vatra.app.push.PushSetup
import ro.vatra.core.net.Discovery
import ro.vatra.core.pairing.PairLink
import ro.vatra.core.pairing.PairState
import ro.vatra.core.pairing.Pairing
import ro.vatra.ui.LocalVatraColors
import ro.vatra.ui.VatraMark

/** Join a home: scan the hub's QR, pick a hub found on Wi-Fi, or type its address. */
@Composable
fun AddHubScreen(invite: PairLink?, canCancel: Boolean, onDone: () -> Unit) {
    val ctx = LocalContext.current
    val app = VatraApp.from(ctx)
    val scope = rememberCoroutineScope()
    val c = LocalVatraColors.current
    var state by remember { mutableStateOf<PairState?>(null) }
    var scanning by rememberSaveable { mutableStateOf(false) }
    var address by rememberSaveable { mutableStateOf("") }
    var email by rememberSaveable { mutableStateOf("") }
    var password by remember { mutableStateOf("") }
    val deviceName = remember { Settings.Global.getString(ctx.contentResolver, Settings.Global.DEVICE_NAME) ?: Build.MODEL }
    val pairing = remember { Pairing(deviceName, VatraApp.language(ctx)) }
    val found by remember { Discovery(ctx).scan() }.collectAsState(initial = emptyList())
    val camera = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { ok -> scanning = ok }

    fun finish(s: PairState) {
        state = s
        if (s is PairState.Paired) scope.launch {
            app.hubs.update { it.add(s.hub) }
            PushSetup.refresh(app, s.hub)
            onDone()
        }
    }

    LaunchedEffect(invite) {
        invite?.let { l -> finish(pairing.withInvite(l) { state = it }) }
    }

    Column(
        Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(24.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        VatraMark(size = 96.dp, line = c.fg, flame = c.primary, core = c.lit, description = stringResource(R.string.app_name))
        Text(stringResource(R.string.add_title), style = MaterialTheme.typography.headlineSmall)
        Text(stringResource(R.string.add_body), color = c.fgMuted)

        when (val s = state) {
            PairState.Working -> CircularProgressIndicator()
            is PairState.AwaitingApproval -> Column(horizontalAlignment = Alignment.CenterHorizontally, modifier = Modifier.semantics { liveRegion = LiveRegionMode.Polite }) {
                Text(stringResource(R.string.add_waiting), style = MaterialTheme.typography.titleMedium)
                Text(s.code, style = MaterialTheme.typography.displayMedium)
            }
            is PairState.Failed -> Text(failText(s), color = c.danger, modifier = Modifier.semantics { liveRegion = LiveRegionMode.Assertive })
            else -> Unit
        }

        if (scanning) {
            QrScanner(
                onCode = { raw ->
                    PairLink.parse(raw)?.let { l ->
                        scanning = false
                        scope.launch { finish(pairing.withInvite(l) { state = it }) }
                    }
                },
                modifier = Modifier.fillMaxWidth().height(320.dp),
            )
        } else {
            Button(onClick = {
                if (ContextCompat.checkSelfPermission(ctx, Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED) scanning = true
                else camera.launch(Manifest.permission.CAMERA)
            }, modifier = Modifier.fillMaxWidth()) { Text(stringResource(R.string.add_scan)) }
        }

        if (found.isNotEmpty()) {
            Text(stringResource(R.string.add_found), style = MaterialTheme.typography.titleMedium, modifier = Modifier.fillMaxWidth())
            found.forEach { h ->
                ListItem(
                    headlineContent = { Text(h.name) },
                    supportingContent = { Text(h.baseUrl) },
                    trailingContent = { TextButton(onClick = { address = h.baseUrl }) { Text(stringResource(R.string.add_use)) } },
                )
            }
        }

        OutlinedTextField(address, { address = it }, label = { Text(stringResource(R.string.add_address)) }, singleLine = true, modifier = Modifier.fillMaxWidth(), keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Uri))
        OutlinedTextField(email, { email = it }, label = { Text(stringResource(R.string.add_email)) }, singleLine = true, modifier = Modifier.fillMaxWidth(), keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Email))
        OutlinedTextField(password, { password = it }, label = { Text(stringResource(R.string.add_password)) }, singleLine = true, visualTransformation = PasswordVisualTransformation(), modifier = Modifier.fillMaxWidth(), keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password))
        Button(
            enabled = address.isNotBlank() && email.isNotBlank() && password.isNotEmpty() && state != PairState.Working,
            onClick = { scope.launch { finish(pairing.withLogin(address, email.trim(), password) { state = it }) } },
            modifier = Modifier.fillMaxWidth(),
        ) { Text(stringResource(R.string.add_sign_in)) }
        OutlinedButton(
            enabled = address.isNotBlank() && state != PairState.Working,
            onClick = { scope.launch { finish(pairing.withApproval(address) { state = it }) } },
            modifier = Modifier.fillMaxWidth(),
        ) { Text(stringResource(R.string.add_request)) }
        if (canCancel) TextButton(onClick = onDone) { Text(stringResource(R.string.cancel)) }
    }
}

@Composable
private fun failText(s: PairState.Failed): String = when (s.code) {
    "offline" -> stringResource(R.string.err_offline)
    "not_vatra" -> stringResource(R.string.err_not_vatra)
    "too_old" -> stringResource(R.string.update_app)
    "rejected" -> stringResource(R.string.err_rejected)
    "expired" -> stringResource(R.string.err_expired)
    "bad_address" -> stringResource(R.string.err_address)
    else -> s.message.ifEmpty { stringResource(R.string.err_generic, s.code) }
}
