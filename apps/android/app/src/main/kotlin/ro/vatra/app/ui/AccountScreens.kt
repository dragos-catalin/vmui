package ro.vatra.app.ui

import android.content.ActivityNotFoundException
import android.content.Context
import android.content.Intent
import android.net.Uri
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
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
import kotlinx.coroutines.launch
import ro.vatra.app.R
import ro.vatra.app.VatraApp
import ro.vatra.core.hub.PairedHub
import ro.vatra.core.net.ApiResult
import ro.vatra.ui.LocalVatraColors

/** Opens a page of the hub (privacy policy, account deletion info) in the browser. */
fun openHubPage(ctx: Context, hub: PairedHub, path: String) {
    val uri = Uri.parse(hub.baseUrl.trimEnd('/') + path)
    try {
        ctx.startActivity(Intent(Intent.ACTION_VIEW, uri).addCategory(Intent.CATEGORY_BROWSABLE))
    } catch (_: ActivityNotFoundException) {
    }
}

/** Settings section: privacy links for every member, account deletion for everyone but the owner. */
@Composable
fun AccountSection(ui: HomeUi, onDelete: () -> Unit) {
    val ctx = LocalContext.current
    val c = LocalVatraColors.current
    val hub = ui.hub ?: return
    Text(stringResource(R.string.account_title), style = MaterialTheme.typography.titleMedium, modifier = Modifier.padding(top = 16.dp))
    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        TextButton(onClick = { openHubPage(ctx, hub, "/privacy") }) { Text(stringResource(R.string.privacy_policy)) }
        TextButton(onClick = { openHubPage(ctx, hub, "/account/delete") }) { Text(stringResource(R.string.account_delete_info)) }
    }
    when (ui.me?.member?.role) {
        null -> Unit
        "owner" -> Text(stringResource(R.string.account_owner_note), style = MaterialTheme.typography.bodySmall, color = c.fgMuted)
        else -> OutlinedButton(
            onClick = onDelete,
            colors = ButtonDefaults.outlinedButtonColors(contentColor = MaterialTheme.colorScheme.error),
        ) { Text(stringResource(R.string.account_delete)) }
    }
}

/**
 * Confirm screen for POST /api/v1/app/account/delete. On success the hub has already revoked this
 * device, so the hub is forgotten locally and [onDeleted] returns to the add-hub screen.
 */
@Composable
fun DeleteAccountScreen(hub: PairedHub, onCancel: () -> Unit, onDeleted: () -> Unit) {
    val ctx = LocalContext.current
    val app = VatraApp.from(ctx)
    val scope = rememberCoroutineScope()
    val c = LocalVatraColors.current
    var password by rememberSaveable { mutableStateOf("") }
    var busy by rememberSaveable { mutableStateOf(false) }
    var error by rememberSaveable { mutableStateOf<String?>(null) }
    val offlineText = stringResource(R.string.err_offline)
    val genericText = stringResource(R.string.err_generic)

    BackHandler(enabled = !busy, onBack = onCancel)

    Column(Modifier.verticalScroll(rememberScrollState()).padding(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        Text(stringResource(R.string.account_delete_title), style = MaterialTheme.typography.headlineSmall)
        Text(stringResource(R.string.account_delete_warning))
        Text(stringResource(R.string.account_delete_items), color = c.fgMuted)
        Text(stringResource(R.string.account_delete_irreversible), color = MaterialTheme.colorScheme.error)
        OutlinedTextField(
            password,
            { password = it; error = null },
            label = { Text(stringResource(R.string.add_password)) },
            singleLine = true,
            enabled = !busy,
            visualTransformation = PasswordVisualTransformation(),
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password),
            modifier = Modifier.fillMaxWidth(),
        )
        error?.let {
            Text(it, color = MaterialTheme.colorScheme.error, modifier = Modifier.semantics { liveRegion = LiveRegionMode.Polite })
        }
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
            Button(
                onClick = {
                    busy = true
                    error = null
                    scope.launch {
                        when (val r = app.client(hub).deleteAccount(password)) {
                            is ApiResult.Ok -> {
                                app.hubs.update { it.remove(hub.id) }
                                onDeleted()
                            }
                            is ApiResult.Refused -> error = r.message.ifEmpty { genericText.format(r.code) }
                            is ApiResult.Offline -> error = offlineText
                            is ApiResult.TooOld -> error = genericText.format("min_client_${r.minClient}")
                        }
                        busy = false
                    }
                },
                enabled = password.isNotEmpty() && !busy,
                colors = ButtonDefaults.buttonColors(containerColor = MaterialTheme.colorScheme.error, contentColor = MaterialTheme.colorScheme.onError),
            ) { Text(stringResource(R.string.account_delete_confirm)) }
            TextButton(onClick = onCancel, enabled = !busy) { Text(stringResource(R.string.cancel)) }
            if (busy) CircularProgressIndicator(Modifier.size(24.dp))
        }
    }
}
