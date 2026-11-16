# QUA-01 — individual Settings readback references

**Status: four owning journeys PASS; final integrated qualification outstanding.** This continues the [native campaign](./QUA-01.native-20261116.md) after `cb24b34be7f4fb3db1364c6706d7a7de07eba15c`. Historical failures and exactly three existing incident acceptances remain unchanged. No runtime diagnosis, new waiver or global green follows.

## Reference decision and limits

The four references originate at `69100d29`. The earlier [source comparison](./QUA-01.native-20261116/settings-review-source-comparison.json.gz) proves the Defaults component and three relevant stylesheets unchanged since that reference commit. The surrounding document is not unchanged: `23277892` adds the explicit Vertex credential selector before Defaults, and the provider lifecycle inventory has evolved. The prior fractional-geometry observation demonstrates raster sensitivity but **does not explain every differing pixel or establish one common cause**; its failed assertion and temporary-overlay compilation error remain retained.

The subsequent individual actual/expected review finds the same intended contents, values, disabled controls, line wrapping and readable boundaries in all four current captures. There is no demonstrated product defect to bypass. This is a bounded decision to maintain references for that valid current rendering, not a causal claim that the old comparison failures were harmless in every environment. It supersedes the earlier conservative decision to leave these references unchanged, without retroactively changing those failed results.

Only the four reviewed PNGs change. Each is copied byte-for-byte from the original official Docker campaign's **untransformed** actual image. No CSS transform, positioning normalization, masks, relaxed comparator, deadline change or snapshot-regeneration option is delivered. [Old/new SHA-256 and capture origins](./QUA-01.native-20261116/settings-references.json.gz) bind each change; previous reference bytes remain in Git at the starting commit.

| Reference | Retained original difference | Individual review |
|---|---:|---|
| en/light/1280 | 355 pixels | Same English title/refusal, saved-scope values, disabled inputs and Save, and enabled reload action. Only small control/text-edge raster differences; no lost text, wrapping or bounds change |
| en/dark/390 | 1,921 | Same narrow English wraps and dark-theme disabled state. Approximately pixel-scale offsets around budget/help/actions; no obscured refusal or truncated control |
| fr/light/390 | 9,649 | Same two-line French heading, multi-line refusal/help and values; small distributed vertical offsets, without losing any wrapped text, control or boundary |
| fr/dark/1280 | 7,376 | Same desktop French heading/refusal/help, values and disabled controls. Pixel-scale vertical/control-edge differences; the earlier geometry observation remains supporting sensitivity evidence, not a complete rendering diagnosis |

## Unchanged owning control

The immutable S1 image `sha256:3c629dbbed96414917c1b9b6b8a9ab04bc6b1582da3df3882d3392818207f291` receives only these four reference overlays. The official `.docker/run-e2e.mjs e2e/settings-administration-live.spec.ts --reporter=line,json` runs the **whole existing file** with default Docker bridge networking, disposable HOME/stores and synthetic local authentication. No test source or product is altered. [Command/exits/times](./QUA-01.native-20261116/settings-references-command.json.gz), [full log](./QUA-01.native-20261116/settings-references.log.gz) and [complete report](./QUA-01.native-20261116/settings-references-report.json.gz) record **4/4 PASS**, zero retries/skips/flaky, in one attempt.

This verifies not only the strict screenshot comparator but all original real HTTP/storage assertions: denied non-admin writes; scoped dirty-field preservation; null/removal inheritance; durable writes despite a dropped reply; unreadable-store write refusal, disabled state and no marker disclosure; zero scoped Axe violations; restored-store reload; exact-filter model and package batches; persisted hidden/unselected items; reload/readback and no horizontal overflow. The post-screenshot controls, previously unreached in the failed campaign, now receive owning-scenario evidence.

## Qualification boundary

Together with the [five minimap references](./QUA-01.minimap-references-20261116.md), known browser fixture/reference repairs now have their owning checks. The original754/12 browser gate and all intermediate failures remain recorded, not arithmetically converted into a pass. S1 plus these four overlays is not the combined current source: later locator/import repairs and minimap references were checked separately.

The next mandatory step is one frozen, coherent integrated campaign with the accumulated verified repairs. The two earlier root timeouts remain unexplained; the separately authorized storage observation did not reproduce or repair them. Another failure will be retained and classified, not retried automatically. Remote CI remains separate and uncredited. QUA-01 and the goal remain incomplete, audit39/43 unchanged.
