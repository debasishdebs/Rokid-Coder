package com.anezium.rokidbus.plugin.agents.ui.theme

import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Shapes
import androidx.compose.material3.Typography
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

/** PCA palette (ported from PcTheme): white surfaces, mint/sky accents, pastel chips. Light only. */
object AgentsColors {
    // Raw ARGB values, so the palette can be checked without a Compose runtime.
    const val MINT_ARGB = 0xFF14C3A2L
    const val MINT_DEEP_ARGB = 0xFF0E9F86L
    const val SKY_ARGB = 0xFF3D8BFFL
    const val INK_ARGB = 0xFF15181DL
    const val INK_SOFT_ARGB = 0xFF6B7280L
    const val LINE_ARGB = 0xFFECEFF3L
    const val SURFACE_ARGB = 0xFFFFFFFFL
    const val SURFACE_SOFT_ARGB = 0xFFF6F8FAL

    val Mint = Color(MINT_ARGB)
    val MintDeep = Color(MINT_DEEP_ARGB)
    val Sky = Color(SKY_ARGB)
    val Ink = Color(INK_ARGB)
    val InkSoft = Color(INK_SOFT_ARGB)
    val Line = Color(LINE_ARGB)
    val Surface = Color(SURFACE_ARGB)
    val SurfaceSoft = Color(SURFACE_SOFT_ARGB)

    // Pastel chip pairs (background, foreground).
    val ChipMint = Color(0xFFE3F8F3) to Color(0xFF0E9F86)
    val ChipSky = Color(0xFFE6F0FF) to Color(0xFF2F6FE0)
    val ChipCoral = Color(0xFFFFEAE5) to Color(0xFFE5583B)
    val ChipAmber = Color(0xFFFFF4DC) to Color(0xFFD08A00)
    val ChipViolet = Color(0xFFF0EAFF) to Color(0xFF7550E0)
    val ChipRose = Color(0xFFFFE8F1) to Color(0xFFD63F7A)
    val ChipSlate = Color(0xFFEEF1F5) to Color(0xFF55606E)

    val HeaderGradient = Brush.verticalGradient(listOf(Color(0xFFDDF7F0), Color(0xFFE8F1FF), Color(0xFFFFFFFF)))
    val PrimaryGradient = Brush.linearGradient(listOf(Mint, Sky))
}

private val colors = lightColorScheme(
    primary = AgentsColors.Mint,
    onPrimary = Color.White,
    primaryContainer = AgentsColors.ChipMint.first,
    onPrimaryContainer = AgentsColors.MintDeep,
    secondary = AgentsColors.Sky,
    background = AgentsColors.Surface,
    onBackground = AgentsColors.Ink,
    surface = AgentsColors.Surface,
    onSurface = AgentsColors.Ink,
    surfaceVariant = AgentsColors.SurfaceSoft,
    onSurfaceVariant = AgentsColors.InkSoft,
    outline = AgentsColors.Line,
    outlineVariant = AgentsColors.Line,
)

private val typography = Typography(
    headlineMedium = TextStyle(fontSize = 26.sp, fontWeight = FontWeight.Bold, letterSpacing = (-0.3).sp),
    titleLarge = TextStyle(fontSize = 20.sp, fontWeight = FontWeight.SemiBold),
    titleMedium = TextStyle(fontSize = 16.sp, fontWeight = FontWeight.SemiBold),
    bodyMedium = TextStyle(fontSize = 14.sp),
    labelMedium = TextStyle(fontSize = 12.sp, fontWeight = FontWeight.Medium),
)

private val shapes = Shapes(small = RoundedCornerShape(12.dp), medium = RoundedCornerShape(18.dp), large = RoundedCornerShape(24.dp))

@Composable
fun AgentsTheme(content: @Composable () -> Unit) =
    MaterialTheme(colorScheme = colors, typography = typography, shapes = shapes, content = content)
