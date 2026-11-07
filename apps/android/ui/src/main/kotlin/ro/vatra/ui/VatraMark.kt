package ro.vatra.ui

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.layout.size
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.StrokeJoin
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.drawscope.translate
import androidx.compose.ui.graphics.drawscope.scale
import androidx.compose.ui.graphics.vector.PathParser
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp

/** The optical size the brand prescribes for a rendered size (brand/BRAND.md). */
fun opticalFor(size: Dp): VatraMarkGeometry = when {
    size <= 20.dp -> VatraMarks.micro
    size <= 48.dp -> VatraMarks.small
    else -> VatraMarks.master
}

/** The Vatra mark drawn from the same geometry as the web and desktop logos, never a raster. */
@Composable
fun VatraMark(
    size: Dp,
    line: Color,
    flame: Color,
    core: Color,
    modifier: Modifier = Modifier,
    description: String? = null,
) {
    val g = opticalFor(size)
    val paths = remember(g) {
        listOf(g.roof, g.walls, g.flame).map { PathParser().parsePathString(it).toPath() } +
            listOfNotNull(g.core?.let { PathParser().parsePathString(it).toPath() })
    }
    val sem = if (description != null) Modifier.semantics { contentDescription = description } else Modifier
    Canvas(modifier.size(size).then(sem)) {
        val b = g.bbox
        val k = minOf(this.size.width / (b[1] - b[0]), this.size.height / (b[3] - b[2]))
        translate(left = -b[0] * k + (this.size.width - (b[1] - b[0]) * k) / 2f, top = -b[2] * k + (this.size.height - (b[3] - b[2]) * k) / 2f) {
            scale(k, pivot = Offset.Zero) {
                val stroke = Stroke(width = g.stroke, cap = StrokeCap.Round, join = StrokeJoin.Round)
                drawPath(paths[0], line, style = stroke)
                drawPath(paths[1], line, style = stroke)
                drawPath(paths[2], flame)
                paths.getOrNull(3)?.let { drawPath(it, core) }
                val alpha = floatArrayOf(0.95f, 0.7f, 0.45f)
                g.puffs.forEachIndexed { i, p -> drawCircle(line.copy(alpha = alpha.getOrElse(i) { 0.45f }), p.r, Offset(p.cx, p.cy)) }
            }
        }
    }
}
