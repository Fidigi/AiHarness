# Loading the file pane

Open **Files / workspace** to load the explorer and its stylesheet. A closed pane does not download those optional assets. A saved desktop default-open preference still opens the pane.

| State | Available actions |
|---|---|
| Loading | Close or Cancel; the conversation, composer, Stop and command palette remain available |
| Download failure | Read the local error, Close or Cancel, or explicitly select **Reload and retry** |
| Ready | Use the existing file tree, viewer, uploads and Git controls |

Loading is not a modal dialog: it does not trap focus or automatically focus the composer. Closing the pane or changing workspace, conversation or route retires the pending view. A late download cannot reopen the old pane or replay its file request into the replacement view.

A file link clicked while loading retains only the latest bounded file-opening intent. Once the real pane is ready, its existing path, permission and file-read rules still apply. Loading grants no additional filesystem access.

[WARNING] Copy any unsent text before **Reload and retry**: reloading the page may lose it. Closing and reopening alone cannot repair a rejected JavaScript or stylesheet import. Retry deliberately reloads the document; it does not pretend that the failed import was reset. Reloading is not a Stop request for a detached agent run.

This boundary changes asset loading, not the explorer's file, upload, Git or workspace-trust capabilities.

## Related documentation

- [User guide](./user-guide.md)
- [Settings text loading](./settings-loading.md)
- [French version](../fr/workspace-loading.md)
