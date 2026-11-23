# Web replies and live progress

## Output limits and interrupted replies

An explicit provider output limit leaves an **Output limit reached. Ask to continue.** note on the saved assistant reply, including an empty reply. Ask the model to continue; the notice is not inferred from the wording of its answer.

The latest exhausted reply offers **Compact context** when the workspace is trusted and no run or compaction is active. Compaction changes effective model context; it does not erase the transcript. **Stop** remains available during automatic compaction. Cancelling does not undo an already-started persistence operation.

If a provider fails after displaying text or reasoning, that partial reply and a bounded error remain adjacent after reload. This is failure evidence, not a completed answer or an invented usage charge.

## Concurrent extension requests

Pending extension requests retain their admission order. The active form shows the waiting count; submit or cancel it to reveal the next request. Each request can be closed independently. Updating the same request preserves compatible drafts and validates against its current schema.

Attention sounds once when a request is newly displayed, not on each progress update or reconnect. Stop and extension rebuild revoke the outstanding requests. A saved response to a retired request cannot authorize a new one.

## Process details and reconnect

Related reasoning, tools and command output share a process group even when the loaded history starts mid-turn. Opening native output keeps that disclosure and focus stable while optional formatting/actions load. If optional display code fails, plain output remains available; reload explicitly retries a cached failed import.

Reconnect restores the active phase and latest tool progress within the current server generation. Slow connections may skip superseded running progress or text deltas only when complete replacement records exist; lifecycle and terminal records are not silently discarded. Running progress is process-local, **not crash-durable**. Saved terminal replies/results are separate.

See [the user guide](./user-guide.md) for trust, sessions and commands, and [the technical contract](../../ai/topics/detached-streams.md) for source ownership and limits.
