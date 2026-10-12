# Mobile keyboard layout

On a touch-oriented narrow screen, focusing an editable field can collapse secondary chat controls when the browser reports substantial keyboard-sized viewport loss. Send/Queue, Stop, images and the transcript remain available. Model/default-scope controls return when the keyboard closes; a focused control is not hidden.

## Detection and focus

- Detection needs editable focus, a coarse pointer and a layout width of at most 959 CSS pixels. Buttons, selects, readonly/disabled fields and `inputmode="none"` do not open compact mode.
- Pinch zoom alone, small toolbar changes and viewport panning are not classified as keyboard opening. Zoom is normalized against a previously observed unzoomed baseline.
- After rotating while editing, move focus away before establishing the new orientation's baseline.
- Switching workspace, conversation or navigation retires pending layout work. A reused focused textarea needs fresh focus, input or composition intent in the replacement view.

Compact mode retains the configured Enter/Mod+Enter behavior, multiline input and composition protection. Closing the keyboard does not send a message or stop a run.

## Stylesheet loading and recovery

The chat-only stylesheet loads on eligible keyboard intent, not on every page load. Chat remains in its normal layout until the stylesheet is ready and current geometry/focus is checked again.

If the request fails or stalls for eight seconds, ordinary layout and input remain usable. Resize events do not repeatedly retry. Dismiss the keyboard or move focus away to produce a closed sample, then focus the editable field again. This retry does not reload the page or discard draft text.

Leaving chat removes the owned stylesheet/listeners. MCP Settings remains independently scrollable and editable; use `/mcp` to navigate there locally. Chat layout changes do not authorize files, change trust, or execute MCP tools.

## Limits

**[IMPORTANT]** Browser viewport signals are not proof of a native keyboard. Floating/overlay keyboards without resize, an initially resized or zoomed viewport without a trustworthy baseline, and geometry changes without subsequent browser/input events may remain undetected. Physical Android/iOS/Safari keyboards, candidate bars and nonzero device safe areas have not been certified by the Chromium emulation tests. The normal responsive layout remains the fallback.

See the [user guide](./user-guide.md) and [file-pane loading guide](./workspace-loading.md).
