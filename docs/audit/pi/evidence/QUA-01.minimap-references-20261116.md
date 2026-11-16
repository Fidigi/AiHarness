# QUA-01 — individual history-minimap reference maintenance

**Status: scoped reference repair verified, QUA-01 still PARTIAL.** This continues the [native campaign](./QUA-01.native-20261116.md) after `d1a4bb111633c018a3c37ad7bcbe79ad3e237635`. The original root/browser failures, later observations and exactly three historical incident acceptances remain. No current integrated green or remote CI success is claimed.

## Demonstrated mismatch with the current scenario

The five affected references last changed at `39d300bb` (v0.1.0). Subsequent delivered changes explain concrete mismatches, rather than merely a desire to make screenshots pass:

- `9e2d5fcc` (WEB-02) moves `.scroll-bottom` from absolute positioning into the composer flow and strengthens this same visual scenario with a native-click reading-anchor comparison. Its unchanged assertion requires message101 to remain within **3px** of the pre-pagination anchor.
- The current scenario explicitly requires **no numbered Back-to-bottom badge** after loading earlier history. The old tablet-dark, tablet-light and mobile-light images visibly contain **“Back to bottom (80)”**, inconsistent with that existing assertion. Current reading-tail handling (`53e47611`, retained by WEB-02) separates newly arrived messages from an older page; baseline maintenance does not reintroduce the incorrect count or replace that product correction.
- `58f1bab1` (WEB-06) delivers the child-agent control. `024cc5b1` delivers explicit linked-directory controls. Current desktop captures additionally include the delivered workspace/navigation controls. None is hidden to reproduce the old frame.
- The scenario now checks virtualized message count, loaded160/180, accessible preview width, no horizontal overflow, settled fonts and preserved reading anchor before the screenshot. No assertion, deadline, tolerance, content, viewport or test code is changed here.

## Individual decisions

Each actual/expected pair was reviewed separately. Changed references are copied byte-for-byte from retained **Docker-produced** actual PNGs, not painted, transformed, globally regenerated or captured on the host. Their old/new SHA-256 values and capture origins are in the [reference receipt](./QUA-01.native-20261116/minimap-references.json.gz); old expected bytes remain in Git at the starting commit.

| Reference | Failure retained | Individual justification |
|---|---|---|
| desktop-dark | Original campaign: 34,665 differing pixels | Admit the delivered child-agent, linked-directory/navigation controls and in-flow return/composer layout; retain readable160/180 map and current native-click-preserved reading frame rather than the obsolete absolute-button layout |
| tablet-dark | Original campaign: 24,637 | Replace the demonstrably incorrect “(80)” older-page badge and absolute floating return button with the unnumbered in-flow control; include the delivered child-agent control and preserved reading frame |
| mobile-light | Original campaign: 9,287 | Remove the obsolete floating “(80)” badge, retain the narrow-screen map/preview and composer arrangement under the current in-flow return layout, and include the child-agent control |
| desktop-light | First targeted verification: 46,978 | Separately inspected light-theme frame: the old reference lacks the delivered child-agent and linked-directory/navigation controls and uses the previous composer/reading layout; current map text/controls remain legible |
| tablet-light | First targeted verification: 33,529 | Separately inspected light-theme frame: the old reference also contains the prohibited “(80)” badge and floating return button; current frame has the unnumbered in-flow control, child-agent button and preserved reading anchor |

`mobile-dark` passes without a reference change and is deliberately left untouched. A passing 2% comparison is not a claim of pixel identity. These five updates do not approve the four unrelated Settings readback differences or any unreviewed image.

## Verification and source coherence

Both attempts use immutable S1 test image `sha256:3c629dbbed96414917c1b9b6b8a9ab04bc6b1582da3df3882d3392818207f291`, default Docker bridge network, disposable stores, and the official `.docker/run-e2e.mjs e2e/visual.spec.ts '--grep=Régression visuelle des historiques paginés' --reporter=line,json`. No snapshot-update option is used; all six existing variants run with **one worker, zero retries**, unchanged **0.02** comparison ceiling. [Exact commands/exits/times](./QUA-01.native-20261116/minimap-commands.json.gz), full logs and JSON reports are archived.

1. **S1 + three initial reference overlays:** `minimap-references` reports **4 PASS / 2 FAIL**. All three updated references pass, as does unchanged mobile-dark. Previously passing desktop-light/tablet-light now fail against their still-old references. Their earlier passes remain historical evidence; the reason their old-reference comparison differed between executions is not diagnosed or waived.
2. **S1 + five individually reviewed reference overlays:** after reviewing those two newly failing pairs and changing only their references, `minimap-references-five` reports **6/6 PASS**, including all anchor, paging, accessibility/layout and screenshot assertions. This explicit changed input, not automatic retry, justifies the second attempt. No further repetition follows.

Product source is unchanged. The image does not include the unrelated later locator/import fixture commits, so this is **owning-scenario evidence only**, not qualification of the combined current branch. There is no new product fix, runtime/CI configuration, framework or waiver. The new light-theme actual/diff artifacts are preserved alongside the original three failures.

## Remaining work

At this checkpoint, the complete root gate still has two unexplained timeouts and **four Settings readback visual failures** remain unresolved. The subsequent [Settings reference receipt](./QUA-01.settings-references-20261116.md) records four owning-journey passes after individual review; it does not supply final integrated evidence. All mandatory gates must eventually qualify coherent final inputs; neither the old754/12 browser outcome nor the new4/2 targeted failure is erased or arithmetically converted into a global pass. Remote CI remains uncredited under the existing contract. QUA-01 and the goal remain incomplete; audit closure stays39/43.
