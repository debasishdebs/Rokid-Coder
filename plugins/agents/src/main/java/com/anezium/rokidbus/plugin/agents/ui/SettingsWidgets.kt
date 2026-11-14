package com.anezium.rokidbus.plugin.agents.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyListScope
import androidx.compose.foundation.selection.toggleable
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.ui.unit.dp
import com.anezium.rokidbus.plugin.agents.ui.theme.AgentsColors

// Ported from PCA's SettingsWidgets.kt. PCA's SoftCard, ScreenHeader and GradientButton live in
// its core:ui module; they are private here because only these widgets use them.

/** One settings screen: header + scrolling cards. */
@Composable
fun SettingsPage(title: String, onBack: () -> Unit, tag: String, actions: @Composable () -> Unit = {}, content: LazyListScope.() -> Unit) {
    LazyColumn(Modifier.fillMaxSize().background(AgentsColors.SurfaceSoft).testTag(tag)) {
        item { ScreenHeader(title, onBack, actions) }
        content()
        item { Spacer(Modifier.height(24.dp)) }
    }
}

@Composable
fun SettingsCard(modifier: Modifier = Modifier, content: @Composable ColumnScope.() -> Unit) {
    SoftCard(modifier.padding(horizontal = 16.dp, vertical = 6.dp).fillMaxWidth()) {
        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp), content = content)
    }
}

@Composable
fun SectionLabel(text: String) {
    Text(
        text.uppercase(),
        style = MaterialTheme.typography.labelMedium,
        color = AgentsColors.InkSoft,
        modifier = Modifier.padding(start = 20.dp, top = 20.dp, bottom = 8.dp),
    )
}

@Composable
fun SwitchRow(title: String, subtitle: String?, checked: Boolean, onChange: (Boolean) -> Unit, tag: String, enabled: Boolean = true) {
    // The whole row is the switch, so TalkBack reads "<title>, switch, on" (the Switch itself takes no input).
    Row(
        Modifier.fillMaxWidth().heightIn(min = 48.dp).toggleable(value = checked, enabled = enabled, role = Role.Switch, onValueChange = onChange).testTag(tag),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Column(Modifier.weight(1f)) {
            Text(title, style = MaterialTheme.typography.titleMedium)
            if (subtitle != null) Text(subtitle, style = MaterialTheme.typography.bodyMedium, color = AgentsColors.InkSoft)
        }
        Switch(checked = checked, onCheckedChange = null, enabled = enabled)
    }
}

/** A labelled single choice (announced "<title>: <value>"); the menu items are tagged "<tag>_<index>". */
@Composable
fun ChoiceRow(title: String, options: List<String>, selected: Int, onSelect: (Int) -> Unit, tag: String, enabled: Boolean = true, disabled: Set<Int> = emptySet(), disabledReason: String? = null) {
    var open by remember { mutableStateOf(false) }
    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
        Text(title, Modifier.weight(1f), style = MaterialTheme.typography.bodyMedium)
        Box {
            val value = options.getOrElse(selected) { "—" }
            TextButton(onClick = { open = true }, enabled = enabled, modifier = Modifier.testTag(tag).semantics { contentDescription = "$title: $value" }) { Text(value) }
            DropdownMenu(expanded = open, onDismissRequest = { open = false }) {
                options.forEachIndexed { i, o ->
                    val off = i in disabled
                    // A greyed-out option says why to TalkBack, not just in a notice below the menu.
                    val why = if (off && disabledReason != null) Modifier.semantics { contentDescription = "$o \u2014 $disabledReason"; stateDescription = "Unavailable" } else Modifier
                    DropdownMenuItem(text = { Text(o) }, onClick = { open = false; onSelect(i) }, enabled = !off, modifier = Modifier.testTag("${tag}_$i").then(why))
                }
            }
        }
    }
}

/** A secret never goes to the IME's learning or suggestions. */
private val SECRET_KEYBOARD = KeyboardOptions(keyboardType = KeyboardType.Password, autoCorrectEnabled = false)

@Composable
fun TextFieldRow(
    label: String, value: String, onChange: (String) -> Unit, tag: String,
    singleLine: Boolean = true, placeholder: String? = null, secret: Boolean = false, enabled: Boolean = true,
    supporting: String? = null, isError: Boolean = false, number: Boolean = false,
) {
    OutlinedTextField(
        value = value, onValueChange = onChange, label = { Text(label) }, singleLine = singleLine, enabled = enabled, isError = isError,
        placeholder = placeholder?.let { { Text(it) } }, supportingText = supporting?.let { { Text(it) } },
        visualTransformation = if (secret) PasswordVisualTransformation() else VisualTransformation.None,
        keyboardOptions = if (secret) SECRET_KEYBOARD else KeyboardOptions(keyboardType = if (number) KeyboardType.Decimal else KeyboardType.Text),
        modifier = Modifier.fillMaxWidth().testTag(tag),
    )
}

@Composable
fun NoticeText(text: String, error: Boolean = false, tag: String = "notice") {
    Text(text, style = MaterialTheme.typography.bodyMedium, color = if (error) AgentsColors.ChipCoral.second else AgentsColors.InkSoft, modifier = Modifier.testTag(tag))
}

@Composable
fun PrimaryAction(text: String, onClick: () -> Unit, tag: String, enabled: Boolean = true) =
    GradientButton(text, onClick, Modifier.fillMaxWidth().testTag(tag), enabled = enabled)

@Composable
fun SecondaryAction(text: String, onClick: () -> Unit, tag: String, enabled: Boolean = true) =
    TextButton(onClick = onClick, enabled = enabled, modifier = Modifier.testTag(tag)) { Text(text) }

/** White card with a hairline border. */
@Composable
private fun SoftCard(modifier: Modifier = Modifier, content: @Composable () -> Unit) {
    val shape = RoundedCornerShape(20.dp)
    Box(modifier.clip(shape).background(AgentsColors.Surface).border(1.dp, AgentsColors.Line, shape)) { content() }
}

@Composable
private fun ScreenHeader(title: String, onBack: (() -> Unit)?, actions: @Composable () -> Unit = {}) {
    Row(
        modifier = Modifier.fillMaxWidth().statusBarsPadding().padding(horizontal = 8.dp, vertical = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        if (onBack != null) {
            IconButton(onClick = onBack) { Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "Back") }
        } else {
            Spacer(Modifier.width(12.dp))
        }
        Text(title, style = MaterialTheme.typography.headlineMedium, modifier = Modifier.weight(1f))
        Row(horizontalArrangement = Arrangement.spacedBy(4.dp)) { actions() }
    }
}

/** Primary action: Mint to Sky gradient pill. */
@Composable
private fun GradientButton(text: String, onClick: () -> Unit, modifier: Modifier = Modifier, enabled: Boolean = true) {
    Box(
        modifier.clip(RoundedCornerShape(28.dp)).background(AgentsColors.PrimaryGradient).alpha(if (enabled) 1f else 0.45f)
            .clickable(enabled = enabled, role = Role.Button, onClick = onClick).padding(horizontal = 24.dp, vertical = 14.dp),
        contentAlignment = Alignment.Center,
    ) { Text(text, style = MaterialTheme.typography.titleMedium, color = Color.White) }
}
