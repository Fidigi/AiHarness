# Browsing linked directories

Use **Linked directories** in the workspace sidebar or file pane to review a directory link outside configured roots. The source folder field is relative to the source workspace. File names and mentions retain ordinary in-root file policy. Use the separate visible link-review button for source metadata; clicking an ordinary file name does not implicitly grant outside-root consent. A refused symbolic-link read can show source metadata only if its invoker still owns focus; newer composer intent wins. A new explicit link read retires an older loading view before awaiting its result.

## Review and consent

1. Review exact raw and canonical targets, displayed as escaped literals. Hidden/directional-character warnings expose misleading spellings.
2. Choose **Review directory consent**, check **I allow file browsing through this exact directory link.**, then **Allow directory**.
3. Trust the **source workspace separately** before **Browse allowed directory**. Consent alone does not permit file contents.
4. Open ordinary folders or UTF-8 files within that exact target. Use **Back to link metadata** and **Revoke consent** to withdraw the grant.

Inventory and consent read target metadata only: no target directory handle, descendant names or bodies. Browse/read requires fresh selector revision, grant, source trust and source/link/target identities, checked before the target root and every descendant handle and before returning results.

[IMPORTANT] This is scoped read-only browsing, **not** project trust or execution authority. It does not extend allowed roots or authorize general file tools, Git, PTYs, agent working directories, MCP, instructions or provider maintenance. Trusting the source does not trust the target. A privileged process retains its existing OS rights.

## Limits and recovery

| Condition | Result |
|---|---|
| Changed link, replaced target or external revocation | Old selector refused; the next explicit operation clears stale displayed content and reloads metadata. Review and confirm again when appropriate. |
| Nested link, hard-linked/special file or invalid UTF-8 | Refused; even internal nested symbolic links are not followed. |
| Broad/protected target, linked target components or unsupported platform | No usable grant. Current safe external browsing is Linux-only. |
| Unsafe/unavailable private store | Fail closed; never weaken ownership, permissions or file guards. |
| Network/API failure | Local error and Close remain available. Retry reloads authoritative metadata; failure is not an allowance. |
| Optional JS/CSS download failure | Close or explicitly reload to retry; reopening does not reset a rejected import. |

Copy unsent text before reloading: it may be lost. Reloading is not Stop for a detached run. While optional controls load, composer/Stop remain usable without a modal focus trap. Close, navigation, source folder/workspace changes and newer activation retire old requests. Only the ready modal traps focus; ordinary Escape closes it. Composing Escape, including legacy keyCode 229, leaves the ready source edit and IME interaction intact. While controls load, composing Escape is inert and ordinary Escape preserves newer composer focus. If you move focus elsewhere before readiness, the old open request retires without a metadata request; activate Linked directories again. Consent completion and error recovery never override newer focus.

Listings: at most 500 entries, with truncation reported. Paths: 4,096 bytes/64 components. Ordinary files: 2 MiB. Private consent: 128 KiB/256 hashed bindings in `<AI_HARNESS_DATA_DIR>/linked-directories.json`. The data directory must be independent of the source and private to the server OS user. Grants persist across reloads; opaque selectors/revisions must be refreshed and are not portable authority.

Revocation serializes with cooperating in-flight reads; its acknowledgement blocks later access but cannot erase content already delivered. This is not an OS sandbox, global filesystem freeze, hostile same-UID isolation or immunity to inode reuse/bind mounts. Redaction covers registered secrets, not every unknown secret in arbitrary content.

## Related documentation

- [File-pane loading](./workspace-loading.md)
- [User guide](./user-guide.md)
- [French version](../fr/linked-directories.md)
