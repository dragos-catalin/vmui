package ro.vatra.tv

import android.os.Build
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.unit.dp
import androidx.tv.material3.Button
import androidx.tv.material3.Card
import androidx.tv.material3.MaterialTheme
import androidx.tv.material3.Surface
import androidx.tv.material3.Text
import androidx.tv.material3.darkColorScheme
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import ro.vatra.core.home.HomeView
import ro.vatra.core.hub.HubStore
import ro.vatra.core.model.Control
import ro.vatra.core.model.HomeState
import ro.vatra.core.model.Lights
import ro.vatra.core.model.LightsOp
import ro.vatra.core.net.ApiResult
import ro.vatra.core.net.HubClient
import ro.vatra.core.pairing.PairState
import ro.vatra.core.pairing.Pairing
import ro.vatra.ui.VatraDark
import ro.vatra.ui.VatraMark

/** Google TV dashboard: rooms as rows of D-pad focusable cards, scenes on top. Always the dark brand theme. */
class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val c = VatraDark
        val scheme = darkColorScheme(
            primary = c.primary, onPrimary = c.primaryFg, background = c.bg, onBackground = c.fg,
            surface = c.surface, onSurface = c.fg, surfaceVariant = c.surface2, onSurfaceVariant = c.fgMuted,
            inverseSurface = c.fg, inverseOnSurface = c.bg, border = c.borderStrong, error = c.danger,
        )
        setContent { MaterialTheme(colorScheme = scheme) { Surface(Modifier.fillMaxSize()) { TvRoot() } } }
    }
}

private fun lang(c: android.content.Context) = if (c.resources.configuration.locales[0].language == "ro") "ro" else "en"

@Composable
private fun TvRoot() {
    val ctx = LocalContext.current
    val store = remember { HubStore(ctx) }
    val hubs by store.hubs.collectAsState(initial = null)
    val hub = hubs?.active
    if (hubs == null) return
    if (hub == null) TvPair(store) else TvHome(remember(hub) { HubClient(hub.baseUrl, hub.token, lang(ctx)) }, hub.name)
}

@Composable
private fun TvPair(store: HubStore) {
    val ctx = LocalContext.current
    val scope = rememberCoroutineScope()
    var address by remember { mutableStateOf("") }
    var state by remember { mutableStateOf<PairState?>(null) }
    Column(Modifier.padding(48.dp), verticalArrangement = Arrangement.spacedBy(16.dp)) {
        VatraMark(size = 96.dp, line = VatraDark.fg, flame = VatraDark.primary, core = VatraDark.lit)
        Text(stringResource(R.string.pair_title), style = MaterialTheme.typography.headlineMedium)
        Text(stringResource(R.string.pair_body))
        BasicTextField(
            address, { address = it }, singleLine = true,
            textStyle = TextStyle(color = MaterialTheme.colorScheme.onSurface),
            cursorBrush = SolidColor(MaterialTheme.colorScheme.primary),
            decorationBox = { inner -> if (address.isEmpty()) Text(stringResource(R.string.pair_address)) else inner() },
            modifier = Modifier.width(480.dp),
        )
        Button(onClick = {
            scope.launch {
                val r = Pairing(Build.MODEL, lang(ctx), Pairing.PLATFORM_TV).withApproval(address) { state = it }
                if (r is PairState.Paired) store.update { it.add(r.hub) }
            }
        }) { Text(stringResource(R.string.pair_request)) }
        when (val s = state) {
            is PairState.AwaitingApproval -> Text(stringResource(R.string.pair_code, s.code), style = MaterialTheme.typography.displaySmall)
            is PairState.Failed -> Text(stringResource(R.string.pair_failed, s.code))
            else -> Unit
        }
    }
}

@Composable
private fun TvHome(client: HubClient, name: String) {
    val scope = rememberCoroutineScope()
    var state by remember { mutableStateOf<HomeState?>(null) }
    var lights by remember { mutableStateOf<Lights?>(null) }
    LaunchedEffect(client) {
        while (true) {
            (client.state() as? ApiResult.Ok)?.value?.let { state = it }
            (client.lights() as? ApiResult.Ok)?.value?.let { lights = it }
            delay(5_000)
        }
    }
    LazyColumn(contentPadding = PaddingValues(48.dp), verticalArrangement = Arrangement.spacedBy(24.dp)) {
        item {
            Row(verticalAlignment = androidx.compose.ui.Alignment.CenterVertically) {
                VatraMark(size = 48.dp, line = VatraDark.fg, flame = VatraDark.primary, core = VatraDark.lit)
                Text(name, style = MaterialTheme.typography.headlineMedium, modifier = Modifier.padding(start = 16.dp))
            }
        }
        lights?.scenes?.takeIf { it.isNotEmpty() }?.let { scenes ->
            item {
                Text(stringResource(R.string.scenes), style = MaterialTheme.typography.titleLarge)
                LazyRow(horizontalArrangement = Arrangement.spacedBy(16.dp), contentPadding = PaddingValues(top = 12.dp)) {
                    items(scenes, key = { it.id }) { s -> Button(onClick = { scope.launch { client.lights(LightsOp.ApplyScene(s.id)) } }) { Text(s.name) } }
                }
            }
        }
        state?.let(HomeView::rooms)?.forEach { r ->
            item(key = r.id) {
                Text(r.name, style = MaterialTheme.typography.titleLarge)
                LazyRow(horizontalArrangement = Arrangement.spacedBy(16.dp), contentPadding = PaddingValues(top = 12.dp)) {
                    items(r.devices, key = { it.id }) { d ->
                        Card(
                            onClick = { if (d.toggleable) scope.launch { client.control(Control.Toggle(d.entity!!, d.on != true)); (client.state() as? ApiResult.Ok)?.value?.let { state = it } } },
                            modifier = Modifier.width(220.dp),
                        ) {
                            Column(Modifier.padding(16.dp)) {
                                Text(d.name, style = MaterialTheme.typography.titleMedium)
                                Text(
                                    when (d.on) {
                                        true -> stringResource(R.string.state_on)
                                        false -> stringResource(R.string.state_off)
                                        null -> if (d.available) "" else stringResource(R.string.state_unavailable)
                                    },
                                )
                            }
                        }
                    }
                }
            }
        }
        if (state == null) item { Text(stringResource(R.string.offline)) }
    }
}
