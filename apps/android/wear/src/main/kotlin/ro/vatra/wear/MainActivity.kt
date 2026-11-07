package ro.vatra.wear

import android.os.Build
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.text.KeyboardOptions
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
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.input.KeyboardType
import androidx.wear.compose.foundation.lazy.ScalingLazyColumn
import androidx.wear.compose.foundation.lazy.items
import androidx.wear.compose.material3.AppScaffold
import androidx.wear.compose.material3.Button
import androidx.wear.compose.material3.ListHeader
import androidx.wear.compose.material3.MaterialTheme
import androidx.wear.compose.material3.ScreenScaffold
import androidx.wear.compose.material3.SwitchButton
import androidx.wear.compose.material3.Text
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import ro.vatra.core.home.HomeView
import ro.vatra.core.model.Control
import ro.vatra.core.model.WaterAct
import ro.vatra.core.pairing.PairState
import ro.vatra.core.pairing.Pairing

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContent { MaterialTheme { AppScaffold { WearRoot() } } }
    }
}

@Composable
private fun WearRoot() {
    val ctx = androidx.compose.ui.platform.LocalContext.current
    val app = WearApp.from(ctx)
    val hubs by app.hubs.hubs.collectAsState(initial = null)
    if (hubs == null) return
    if (hubs?.active == null) PairScreen() else HomeList()
}

@Composable
private fun PairScreen() {
    val ctx = androidx.compose.ui.platform.LocalContext.current
    val app = WearApp.from(ctx)
    val scope = rememberCoroutineScope()
    var address by remember { mutableStateOf("") }
    var state by remember { mutableStateOf<PairState?>(null) }
    ScreenScaffold {
        ScalingLazyColumn(Modifier.fillMaxWidth()) {
            item { ListHeader { Text(stringResource(R.string.pair_title)) } }
            item { Text(stringResource(R.string.pair_body)) }
            item {
                BasicTextField(
                    address,
                    { address = it },
                    singleLine = true,
                    textStyle = TextStyle(color = MaterialTheme.colorScheme.onSurface),
                    cursorBrush = SolidColor(MaterialTheme.colorScheme.primary),
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Uri),
                    decorationBox = { inner -> if (address.isEmpty()) Text(stringResource(R.string.pair_address)) else inner() },
                )
            }
            item {
                Button(onClick = {
                    scope.launch {
                        val p = Pairing(Build.MODEL, WearApp.language(ctx), Pairing.PLATFORM_WEAR)
                        val r = p.withApproval(address) { state = it }
                        if (r is PairState.Paired) app.hubs.update { it.add(r.hub) }
                    }
                }) { Text(stringResource(R.string.pair_request)) }
            }
            when (val s = state) {
                is PairState.AwaitingApproval -> item { Text(stringResource(R.string.pair_code, s.code)) }
                is PairState.Failed -> item { Text(stringResource(R.string.pair_failed, s.code)) }
                else -> Unit
            }
        }
    }
}

@Composable
private fun HomeList() {
    val ctx = androidx.compose.ui.platform.LocalContext.current
    val app = WearApp.from(ctx)
    val scope = rememberCoroutineScope()
    var glance by remember { mutableStateOf<WearApp.Glance?>(null) }
    LaunchedEffect(Unit) {
        while (true) {
            glance = app.glance()
            delay(10_000)
        }
    }
    val tiles = glance?.state?.let(HomeView::rooms)?.flatMap { it.devices }?.filter { it.toggleable }.orEmpty()
    ScreenScaffold {
        ScalingLazyColumn(Modifier.fillMaxWidth()) {
            item { ListHeader { Text(stringResource(R.string.app_name)) } }
            glance?.water?.let { w ->
                item {
                    Button(onClick = { scope.launch { app.client()?.water(WaterAct()); glance = app.glance() } }) {
                        Text(stringResource(R.string.water_short, w.ml, w.target))
                    }
                }
            }
            items(tiles, key = { it.id }) { d ->
                SwitchButton(
                    checked = d.on == true,
                    onCheckedChange = { on -> scope.launch { d.entity?.let { app.client()?.control(Control.Toggle(it, on)) }; glance = app.glance() } },
                    label = { Text(d.name) },
                )
            }
            if (glance == null) item { Text(stringResource(R.string.offline)) }
        }
    }
}
