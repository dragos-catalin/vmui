package ro.vatra.ui

import androidx.compose.ui.graphics.Color
import org.junit.Assert.assertTrue
import org.junit.Test
import kotlin.math.pow

/** WCAG 2.2 AA on the pairs the app actually renders as text, in both themes. */
class TokensTest {
    private fun lum(c: Color): Double {
        fun ch(v: Float): Double = if (v <= 0.04045f) v / 12.92 else ((v + 0.055) / 1.055).pow(2.4)
        return 0.2126 * ch(c.red) + 0.7152 * ch(c.green) + 0.0722 * ch(c.blue)
    }

    private fun contrast(a: Color, b: Color): Double {
        val (hi, lo) = listOf(lum(a), lum(b)).sortedDescending()
        return (hi + 0.05) / (lo + 0.05)
    }

    private fun pairs(c: VatraColors) = mapOf(
        "fg/bg" to (c.fg to c.bg),
        "fg/surface" to (c.fg to c.surface),
        "fgMuted/surface" to (c.fgMuted to c.surface),
        "fgSoft/surface" to (c.fgSoft to c.surface),
        "primaryFg/primary" to (c.primaryFg to c.primary),
        "primaryText/surface" to (c.primaryText to c.surface),
        "litFg/lit" to (c.litFg to c.lit),
        "dangerFg/danger" to (c.dangerFg to c.danger),
        "successFg/success" to (c.successFg to c.success),
        "warningFg/warning" to (c.warningFg to c.warning),
    )

    @Test fun lightThemeTextIsAA() = check("light", VatraLight)

    @Test fun darkThemeTextIsAA() = check("dark", VatraDark)

    private fun check(name: String, c: VatraColors) {
        for ((k, v) in pairs(c)) {
            val r = contrast(v.first, v.second)
            assertTrue("$name $k = ${"%.2f".format(r)}", r >= 4.5)
        }
    }

    @Test fun springTokensAreUnderdampedButSettle() {
        val s = VatraMotion.default
        val ratio = s.damping / (2f * kotlin.math.sqrt(s.stiffness * s.mass))
        assertTrue("ratio $ratio", ratio in 0.5f..1.0f)
    }

    @Test fun opticalSizesFollowTheBrand() {
        assertTrue(opticalFor(androidx.compose.ui.unit.Dp(16f)) === VatraMarks.micro)
        assertTrue(opticalFor(androidx.compose.ui.unit.Dp(32f)) === VatraMarks.small)
        assertTrue(opticalFor(androidx.compose.ui.unit.Dp(96f)) === VatraMarks.master)
    }
}
