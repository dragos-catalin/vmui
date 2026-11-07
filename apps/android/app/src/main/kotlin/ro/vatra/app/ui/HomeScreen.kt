package ro.vatra.app.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.FilledTonalButton
import androidx.compose.material3.ListItem
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Slider
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import ro.vatra.app.R
import ro.vatra.core.home.DeviceTile
import ro.vatra.core.home.HomeView
import ro.vatra.ui.LocalVatraColors
import ro.vatra.ui.VatraMark

@Composable
fun HomeScreen(ui: HomeUi, model: HomeModel) {
    val rooms = ui.state?.let(HomeView::rooms).orEmpty()
    val c = LocalVatraColors.current
    LazyColumn(contentPadding = androidx.compose.foundation.layout.PaddingValues(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        item {
            Row(verticalAlignment = Alignment.CenterVertically) {
                VatraMark(size = 32.dp, line = c.fg, flame = c.primary, core = c.lit)
                Column(Modifier.padding(start = 12.dp)) {
                    Text(ui.hub?.name.orEmpty(), style = MaterialTheme.typography.titleLarge)
                    ui.me?.member?.displayName?.let { Text(stringResource(R.string.signed_in_as, it), style = MaterialTheme.typography.bodySmall, color = c.fgMuted) }
                }
            }
        }
        if (ui.offline || ui.state?.haOnline == false) {
            item {
                Card(colors = CardDefaults.cardColors(containerColor = c.warning, contentColor = c.warningFg)) {
                    Text(stringResource(if (ui.offline) R.string.hub_offline else R.string.ha_offline), Modifier.padding(16.dp))
                }
            }
        }
        ui.intercom?.takeIf { it.ringing }?.let { ic ->
            item {
                Card(colors = CardDefaults.cardColors(containerColor = c.primary, contentColor = c.primaryFg)) {
                    Column(Modifier.padding(16.dp)) {
                        Text(stringResource(R.string.door_ringing), style = MaterialTheme.typography.titleMedium)
                        Row(horizontalArrangement = Arrangement.spacedBy(8.dp), modifier = Modifier.padding(top = 8.dp)) {
                            if (ic.canOpen) Button(onClick = { model.door("open") }) { Text(stringResource(R.string.door_open)) }
                            OutlinedButton(onClick = { model.door("ignore") }) { Text(stringResource(R.string.door_ignore)) }
                        }
                    }
                }
            }
        }
        ui.water?.let { w ->
            item {
                Card {
                    Row(Modifier.padding(16.dp).fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                        Column(Modifier.weight(1f)) {
                            Text(stringResource(R.string.water_title), style = MaterialTheme.typography.titleMedium)
                            Text(stringResource(R.string.water_progress, w.ml, w.target), color = c.fgMuted)
                        }
                        OutlinedButton(onClick = model::undoDrink) { Text(stringResource(R.string.undo)) }
                        Spacer(Modifier.padding(4.dp))
                        FilledTonalButton(onClick = model::drink) { Text(stringResource(R.string.water_drink)) }
                    }
                }
            }
        }
        if (ui.me?.can?.manageHome == true || rooms.any { it.canControl }) {
            item {
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    FilledTonalButton(onClick = { model.ambilight("movie") }) { Text(stringResource(R.string.ambilight_movie)) }
                    FilledTonalButton(onClick = { model.ambilight("off") }) { Text(stringResource(R.string.ambilight_off)) }
                    FilledTonalButton(onClick = { model.script("pc_wake") }) { Text(stringResource(R.string.pc_wake)) }
                }
            }
        }
        if (rooms.isEmpty()) item { Text(stringResource(R.string.no_rooms), color = c.fgMuted) }
        items(rooms, key = { it.id }) { r ->
            Card {
                Column(Modifier.padding(vertical = 8.dp)) {
                    Text(r.name, style = MaterialTheme.typography.titleMedium, modifier = Modifier.padding(horizontal = 16.dp, vertical = 4.dp))
                    if (!r.canControl) Text(stringResource(R.string.view_only), style = MaterialTheme.typography.labelSmall, color = c.fgMuted, modifier = Modifier.padding(horizontal = 16.dp))
                    r.devices.forEach { d -> DeviceRow(d, model) }
                }
            }
        }
        item { Spacer(Modifier.height(24.dp)) }
    }
}

@Composable
private fun DeviceRow(d: DeviceTile, model: HomeModel) {
    val on = d.on
    val bri = d.brightnessPct
    val entity = d.entity
    val state = when {
        !d.available -> stringResource(R.string.state_unavailable)
        on == true -> stringResource(R.string.state_on)
        on == false -> stringResource(R.string.state_off)
        else -> ""
    }
    Column {
        ListItem(
            headlineContent = { Text(d.name) },
            supportingContent = { if (state.isNotEmpty()) Text(state) },
            trailingContent = {
                if (on != null) {
                    Switch(
                        checked = on,
                        enabled = d.toggleable,
                        onCheckedChange = { v -> entity?.let { model.toggle(it, v) } },
                        modifier = Modifier.semantics { stateDescription = state },
                    )
                }
            },
        )
        if (d.kind == "light" && on == true && d.toggleable && bri != null && entity != null) {
            var v by remember(bri) { mutableFloatStateOf(bri.toFloat()) }
            Slider(
                value = v,
                onValueChange = { v = it },
                onValueChangeFinished = { model.brightness(entity, v.toInt()) },
                valueRange = 1f..100f,
                modifier = Modifier.padding(horizontal = 16.dp).semantics { stateDescription = "${v.toInt()} %" },
            )
        }
    }
}
