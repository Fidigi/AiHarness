# Remembered Web Settings navigation

AiHarness remembers Settings navigation separately for each server-validated project folder, with a separate context when no project is selected. This is browser presentation memory, not project configuration.

## Finding your way around

**Settings** opens as a dialog over chat, not a long page of stacked sections. Choose **General**, **Models**, **Skills**, **Tools**, **Plugins**, **Child agents** or **MCP**. General and Models then provide a section list; catalogues show a resource list and the selected entry’s detail.

On smaller screens, use the category selector, then **Back…** buttons to return to section or resource lists. **Close** or `Escape` returns to chat; affected unsaved edits require confirmation. Selecting a detail alone never tests, installs or activates a resource.

The [catalogue screenshot](../../screenshots/05-settings/model-catalog-light.png) shows **Models → Model → Manage model catalogue** in English. The [user guide](./user-guide.md#configuring-web-ui) lists other paths and scope rules.

## What returns

- The last Settings section and the last focused group or resource row in that section.
- The Global/Project scope choices for tools, defaults, packages, subagents and skill installation.
- A still-valid row only after fresh data identifies it uniquely. Missing or ambiguous rows fall back to their group or section; another project's row is not substituted.

All current sections have a global or read-only surface without a project. Closing the project does not send you away from a valid section; unavailable Project scope choices fall back to Global.

Search text, pasted configuration, credentials, unsaved fields, revisions, trust decisions and Test/OAuth results are **not** restored by this memory. Restoring a position does not click a control, save configuration, enable a resource or execute a server.

## Project and trust changes

Switch projects through the workspace picker. Returning to the same canonical folder restores that folder's valid navigation rather than the other folder's position.

Canonical workspace identity (including folder path) or trust changes recreate mounted Settings forms and reread their data. Review unsaved edits again: they are not carried into the replacement authority context. An already accepted server operation is not rolled back by a view change.

Focus can return to a usable matching control or a safe group/section. A deferred return yields to newer pointer, wheel, keyboard or focus intent, another dialog, or navigation. Dialogs keep their own normal return; a retired invoker can hand off to the fresh Settings section. When the browser reports a coarse pointer, automatic return avoids editable controls rather than forcing text entry.

## Storage and privacy

Tabs do not follow each other's navigation or forms live. A later focus change conserves freshly stored positions in other sections; this is best-effort browser memory, not cross-tab configuration synchronization.

This optional memory holds folder paths and navigation identifiers in this browser profile for this site. Folder names and resource identifiers may themselves be sensitive. It is bounded to 24 contexts and may discard old or oversized entries. Unavailable, denied or corrupt storage does not change server settings or grant trust; currently mounted scope choices remain usable.

To forget these per-folder positions, close Settings in all tabs, then remove `ai-harness-settings-navigation-v1` in the browser's site-storage tools. Other preferences and server files remain unchanged. An older saved global section can still provide the initial fallback until a new per-folder position is recorded.

See the [Web configuration guide](./user-guide.md#configuring-web-ui) for actual Settings operations and scope rules.
