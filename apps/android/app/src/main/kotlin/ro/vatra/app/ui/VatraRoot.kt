package ro.vatra.app.ui

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Home
import androidx.compose.material.icons.filled.Notifications
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material.icons.filled.Star
import androidx.compose.material3.Badge
import androidx.compose.material3.BadgedBox
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.NavigationBar
import androidx.compose.material3.NavigationBarItem
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import ro.vatra.app.R
import ro.vatra.app.ui.add.AddHubScreen
import ro.vatra.core.pairing.PairLink

private enum class Tab(val label: Int) { Home(R.string.tab_home), Lights(R.string.tab_lights), Alerts(R.string.tab_alerts), Settings(R.string.tab_settings) }

@Composable
fun VatraRoot(model: HomeModel, invite: PairLink?, onInviteUsed: () -> Unit) {
    val ui by model.ui.collectAsStateWithLifecycle()
    var adding by rememberSaveable { mutableStateOf(false) }
    var tab by rememberSaveable { mutableStateOf(Tab.Home) }
    val snack = remember { SnackbarHostState() }

    LaunchedEffect(ui.message) {
        ui.message?.let {
            snack.showSnackbar(it)
            model.consumeMessage()
        }
    }

    if (ui.hub == null || adding || invite != null) {
        AddHubScreen(
            invite = invite,
            canCancel = ui.hub != null,
            onDone = {
                adding = false
                onInviteUsed()
            },
        )
        return
    }

    Scaffold(
        snackbarHost = { SnackbarHost(snack) },
        bottomBar = {
            NavigationBar {
                Tab.entries.forEach { t ->
                    val unread = if (t == Tab.Alerts) ui.cards?.cards?.count { it.readAt == null || it.readAt.toString() == "null" } ?: 0 else 0
                    NavigationBarItem(
                        selected = tab == t,
                        onClick = { tab = t },
                        icon = {
                            BadgedBox(badge = { if (unread > 0) Badge { Text(unread.toString()) } }) {
                                Icon(
                                    when (t) {
                                        Tab.Home -> Icons.Filled.Home
                                        Tab.Lights -> Icons.Filled.Star
                                        Tab.Alerts -> Icons.Filled.Notifications
                                        Tab.Settings -> Icons.Filled.Settings
                                    },
                                    contentDescription = null,
                                )
                            }
                        },
                        label = { Text(stringResource(t.label)) },
                    )
                }
            }
        },
    ) { pad ->
        Box(Modifier.fillMaxSize().padding(pad)) {
            when {
                ui.tooOld -> Text(stringResource(R.string.update_app), Modifier.align(Alignment.Center))
                ui.loading -> CircularProgressIndicator(Modifier.align(Alignment.Center))
                else -> when (tab) {
                    Tab.Home -> HomeScreen(ui, model)
                    Tab.Lights -> LightsScreen(ui, model)
                    Tab.Alerts -> AlertsScreen(ui, model)
                    Tab.Settings -> SettingsScreen(ui, onAddHub = { adding = true })
                }
            }
        }
    }
}
