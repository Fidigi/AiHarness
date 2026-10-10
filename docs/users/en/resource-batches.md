# Model catalogue group controls

In **Settings → Model → Manage model catalogue**, filter by model or provider, then use **Enable displayed** or **Disable displayed** for one provider or the whole displayed catalogue.

- Only displayed rows whose state changes are sent, in one request. Hidden rows and other provider groups retain their state.
- A group action supports at most 500 changed rows. Narrow the filter for a larger group; an action with no changes is disabled.
- Individual checkboxes remain available and send one exact selector.
- With a selected workspace, changes target its project configuration; inherited global values and unrelated settings are preserved. The catalogue reports the effective source.
- The outcome list distinguishes changed, unchanged and failed selectors. A failed entry does not manufacture a successful save.

If a request fails, do not assume nothing reached disk. The client refreshes the canonical catalogue and shows an error. After navigating away during a save, return and use **Refresh catalogue** before retrying. Retired responses cannot replace the catalogue of the new Settings view.

Unreadable configuration is refused, not overwritten. An unreconciled publication returns an explicit uncertain error rather than a stale catalogue. These controls do not save model/reasoning defaults, replace credentials, rename providers or change the current conversation's selected model.

See the [user guide](./user-guide.md) for model selection/defaults and the [contributor contract](../../contributors/en/resource-batches.md) for request and persistence details.
