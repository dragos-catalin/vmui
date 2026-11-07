package ro.vatra.app.ui

import android.content.Intent
import android.provider.Settings
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Card
import androidx.compose.material3.FilledTonalButton
import androidx.compose.material3.ListItem
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.RadioButton
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.launch
import ro.vatra.app.BuildConfig
import ro.vatra.app.R
import ro.vatra.app.VatraApp
import ro.vatra.app.presence.Presence
import ro.vatra.app.push.PushSetup
import ro.vatra.ui.LocalVatraColors

@Composable
fun LightsScreen(ui: HomeUi, model: HomeModel) {
    val l = ui.lights
    val c = LocalVatraColors.current
    LazyColumn(contentPadding = PaddingValues(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        item { Text(stringResource(R.string.scenes), style = MaterialTheme.typography.titleMedium) }
        if (l?.scenes.isNullOrEmpty()) item { Text(stringResource(R.string.no_scenes), color = c.fgMuted) }
        items(l?.scenes.orEmpty(), key = { "s-${it.id}" }) { s ->
            FilledTonalButton(onClick = { model.scene(s.id) }, modifier = Modifier.fillMaxWidth()) { Text(s.name) }
        }
        item { Text(stringResource(R.string.lights), style = MaterialTheme.typography.titleMedium, modifier = Modifier.padding(top = 16.dp)) }
        items(l?.devices.orEmpty(), key = { "d-${it.id}" }) { d ->
            ListItem(
                headlineContent = { Text(d.name) },
                supportingContent = { Text(if (d.health == "ok") d.room else "${d.room} · ${d.health}") },
                trailingContent = {
                    Row(horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                        TextButton(onClick = { model.lightsTarget("dev:${d.id}", false) }) { Text(stringResource(R.string.state_off)) }
                        TextButton(onClick = { model.lightsTarget("dev:${d.id}", true) }) { Text(stringResource(R.string.state_on)) }
                    }
                },
            )
        }
    }
}

@Composable
fun AlertsScreen(ui: HomeUi, model: HomeModel) {
    val cards = ui.cards?.cards.orEmpty()
    val c = LocalVatraColors.current
    LazyColumn(contentPadding = PaddingValues(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        if (cards.isEmpty()) item { Text(stringResource(R.string.no_alerts), color = c.fgMuted) }
        items(cards, key = { it.id }) { card ->
            Card {
                Column(Modifier.padding(16.dp)) {
                    Text(card.title, style = MaterialTheme.typography.titleMedium)
                    if (card.body.isNotEmpty()) Text(card.body)
                    card.subtitle?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = c.fgMuted) }
                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp), modifier = Modifier.padding(top = 8.dp)) {
                        card.actions.forEach { a ->
                            if (a.style == "primary") FilledTonalButton(onClick = { model.cardAction(card.id, a.id) }) { Text(a.label) }
                            else OutlinedButton(onClick = { model.cardAction(card.id, a.id) }) { Text(a.label) }
                        }
                        TextButton(onClick = { model.dismiss(card.id) }) { Text(stringResource(R.string.dismiss)) }
                    }
                }
            }
        }
    }
}

@Composable
fun SettingsScreen(ui: HomeUi, onAddHub: () -> Unit, onDeleteAccount: () -> Unit) {
    val ctx = LocalContext.current
    val app = VatraApp.from(ctx)
    val scope = rememberCoroutineScope()
    val hubs by app.hubList.collectAsState()
    val push by app.prefs.push.collectAsState(initial = null)
    val geofence by app.prefs.geofenceOn.collectAsState(initial = false)
    val c = LocalVatraColors.current
    Column(Modifier.verticalScroll(rememberScrollState()).padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Text(stringResource(R.string.homes), style = MaterialTheme.typography.titleMedium)
        hubs.hubs.forEach { h ->
            ListItem(
                headlineContent = { Text(h.name) },
                supportingContent = { Text(h.baseUrl) },
                leadingContent = { RadioButton(selected = h.id == hubs.active?.id, onClick = { scope.launch { app.hubs.update { it.select(h.id) } } }) },
                trailingContent = {
                    TextButton(onClick = { scope.launch { app.hubs.update { it.remove(h.id) } } }) { Text(stringResource(R.string.forget)) }
                },
                modifier = Modifier.clickable(role = Role.RadioButton) { scope.launch { app.hubs.update { it.select(h.id) } } },
            )
        }
        OutlinedButton(onClick = onAddHub) { Text(stringResource(R.string.add_home)) }

        Text(stringResource(R.string.notifications), style = MaterialTheme.typography.titleMedium, modifier = Modifier.padding(top = 16.dp))
        val methods = buildList {
            if (PushSetup.fcmAvailable) add("fcm" to R.string.push_fcm)
            add("unifiedpush" to R.string.push_unifiedpush)
            add("none" to R.string.push_none)
        }
        methods.forEach { (key, label) ->
            val selected = (push ?: PushSetup.defaultMethod) == key
            Row(
                Modifier.fillMaxWidth().clickable(role = Role.RadioButton) {
                    scope.launch {
                        app.prefs.setPush(key)
                        ui.hub?.let { PushSetup.refresh(app, it) }
                    }
                }.padding(vertical = 4.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                RadioButton(selected = selected, onClick = null)
                Text(stringResource(label), Modifier.padding(start = 8.dp))
            }
        }
        if ((push ?: PushSetup.defaultMethod) == "fcm" && PushSetup.fcmAvailable) {
            val relayed = hubs.active?.relayed == true
            Text(
                stringResource(if (relayed) R.string.push_via_cloud else R.string.push_via_direct),
                style = MaterialTheme.typography.bodySmall,
                color = c.fgMuted,
            )
        }

        if (Presence.available) {
            Row(Modifier.fillMaxWidth().padding(top = 16.dp), verticalAlignment = Alignment.CenterVertically) {
                Column(Modifier.weight(1f)) {
                    Text(stringResource(R.string.presence_title), style = MaterialTheme.typography.titleMedium)
                    Text(stringResource(R.string.presence_body), style = MaterialTheme.typography.bodySmall, color = c.fgMuted)
                }
                Switch(checked = geofence, onCheckedChange = { on -> scope.launch { Presence.setEnabled(ctx, on) } })
            }
        }

        Text(stringResource(R.string.nfc_title), style = MaterialTheme.typography.titleMedium, modifier = Modifier.padding(top = 16.dp))
        Text(stringResource(R.string.nfc_body), style = MaterialTheme.typography.bodySmall, color = c.fgMuted)
        OutlinedButton(onClick = { ctx.startActivity(Intent(ctx, ro.vatra.app.nfc.WriteTagActivity::class.java)) }) { Text(stringResource(R.string.nfc_write)) }

        TextButton(onClick = { ctx.startActivity(Intent(Settings.ACTION_APP_LOCALE_SETTINGS).setData(android.net.Uri.parse("package:${ctx.packageName}"))) }) {
            Text(stringResource(R.string.language))
        }
        AccountSection(ui, onDelete = onDeleteAccount)
        Text("Vatra ${BuildConfig.VERSION_NAME}", style = MaterialTheme.typography.bodySmall, color = c.fgMuted, modifier = Modifier.padding(top = 16.dp))
    }
}
