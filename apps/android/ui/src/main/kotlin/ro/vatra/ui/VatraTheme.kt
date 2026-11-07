package ro.vatra.ui

import androidx.compose.animation.core.SpringSpec
import androidx.compose.animation.core.spring
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.ColorScheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Shapes
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.staticCompositionLocalOf

/** The brand palette of the current theme; MaterialTheme gets the M3 mapping of the same values. */
val LocalVatraColors = staticCompositionLocalOf { VatraLight }

/** M3 roles from the brand semantics — the same mapping the web's globals.css applies. */
fun VatraColors.toColorScheme(dark: Boolean): ColorScheme {
    val base = if (dark) darkColorScheme() else lightColorScheme()
    return base.copy(
        primary = primary,
        onPrimary = primaryFg,
        primaryContainer = surface2,
        onPrimaryContainer = primaryText,
        secondary = accent,
        onSecondary = accentFg,
        tertiary = lit,
        onTertiary = litFg,
        background = bg,
        onBackground = fg,
        surface = surface,
        onSurface = fg,
        surfaceVariant = surfaceMuted,
        onSurfaceVariant = fgMuted,
        surfaceContainerLowest = bg,
        surfaceContainerLow = bgMuted,
        surfaceContainer = surface,
        surfaceContainerHigh = surfaceMuted,
        surfaceContainerHighest = surface2,
        outline = borderStrong,
        outlineVariant = border,
        error = danger,
        onError = dangerFg,
    )
}

val VatraShapes = Shapes(
    small = RoundedCornerShape(VatraRadius.sm),
    medium = RoundedCornerShape(VatraRadius.md),
    large = RoundedCornerShape(VatraRadius.lg),
    extraLarge = RoundedCornerShape(VatraRadius.xl),
)

fun <T> VatraSpring.spec(): SpringSpec<T> {
    // Compose takes a damping RATIO; the token gives physical damping c, so ratio = c / (2 * sqrt(k * m)).
    val ratio = damping / (2f * kotlin.math.sqrt(stiffness * mass))
    return spring(dampingRatio = ratio, stiffness = stiffness / mass)
}

@Composable
fun VatraTheme(dark: Boolean = isSystemInDarkTheme(), content: @Composable () -> Unit) {
    val colors = if (dark) VatraDark else VatraLight
    CompositionLocalProvider(LocalVatraColors provides colors) {
        MaterialTheme(colorScheme = colors.toColorScheme(dark), shapes = VatraShapes, content = content)
    }
}
