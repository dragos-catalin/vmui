package ro.vatra.app.presence

import android.Manifest
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.compose.setContent
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Button
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import ro.vatra.app.R
import ro.vatra.ui.VatraTheme

/**
 * Prominent disclosure before the location prompts (Play policy for background location):
 * what is used, why, and that only "home"/"away" leaves the phone. Foreground first, then "all the time".
 */
class PermissionActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContent {
            VatraTheme {
                var step by remember { mutableIntStateOf(0) }
                val bg = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { finish() }
                val fg = rememberLauncherForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) { r ->
                    if (r[Manifest.permission.ACCESS_FINE_LOCATION] == true) step = 1 else finish()
                }
                Surface {
                    Column(Modifier.fillMaxSize().padding(24.dp), verticalArrangement = Arrangement.spacedBy(16.dp)) {
                        Text(stringResource(R.string.presence_title), style = MaterialTheme.typography.headlineSmall)
                        Text(stringResource(R.string.presence_disclosure))
                        if (step == 0) {
                            Button(onClick = { fg.launch(arrayOf(Manifest.permission.ACCESS_FINE_LOCATION, Manifest.permission.ACCESS_COARSE_LOCATION)) }) { Text(stringResource(R.string.continue_)) }
                        } else {
                            Text(stringResource(R.string.presence_background))
                            Button(onClick = { bg.launch(Manifest.permission.ACCESS_BACKGROUND_LOCATION) }) { Text(stringResource(R.string.continue_)) }
                        }
                        TextButton(onClick = { finish() }) { Text(stringResource(R.string.not_now)) }
                    }
                }
            }
        }
    }
}
