# QUA-01 — Historical visual-difference review, 2026-11-01

**Historical read-only checkpoint: review complete; visual acceptance was pending. QUA-01 remains PARTIAL.**

**Subsequent delegated decision:** the user authorized correcting poor UX or accepting the reviewed rendering. The [follow-up receipt](./QUA-01.visual-acceptance-20261101.json) records the bounded file-reader correction and acceptance of these 18 renders: 17 Docker-generated baseline updates, one reference retained. The observations and failed-assertion outcomes below describe the original review checkpoint, not a new rejection or current qualification. Visual acceptance is not an assertion waiver: the final full replay passes 17 of these cases but still fails the French child-panel comparison on two pixels. Capture stability remains unresolved; no further baseline update or tolerance change hides that failure.

## Scope and method

Reviewed all 18 failing expected/actual/diff triplets from the [native qualification attempt](./QUA-01.native-20261101.json), not a new execution of the current checkout. Historical input bytes are bound by source manifest SHA-256 `b6fb3f91b4540dd04fb83c28bbe5d6f8b35b46603941b07dded05eef57fe6736`. All 18 expected images match their frozen baseline hashes. The [machine-readable receipt](./QUA-01.visual-review-20261101.json) binds each triplet and the local archive.

Each comparison was visually inspected. Playwright's original failure counts and image dimensions were retained; separate raw RGBA measurements are diagnostic, not substitute screenshot assertions. Comparison sheets show expected / actual / diff; images wider than 800 pixels are reduced by two on sheets only, with original PNGs retained. PNG decoding used the original Make-built Docker image with networking disabled. No browser test was rerun, new test added, baseline updated, or assertion/tolerance/deadline/retry changed.

## Findings

- **11 implemented UI changes awaiting visual acceptance:** six provider screens, four workspace-file screens and one session sidebar.
- **5 minor rendering/geometry differences:** one Code mode capture and four MCP captures. Their exact rendering cause is not established.
- **2 isolated border-raster differences:** one and five Playwright-marked pixels respectively.
- **No newly demonstrated functional regression in these 18 image comparisons.** This is not a functional pass or general usability certification. All 18 historical screenshot assertions remain failed; review alone resolves none of the qualification gates.

| ID | Screenshot | Observed difference | Classification / proposed disposition |
|---|---|---|---|
| 01 | `codemode-settings-mobile-light.png` | Same 326 × 1144 section, selections, 500-token value, sandbox limits and disabled reasons. Small vertical offsets in labels, controls and help text account for a distributed diff; Playwright reports 9,487 pixels | Minor rendering difference; propose individual acceptance only after checking the final frozen rendering. No demonstrated reason to change tool policy or CSS merely to chase the old pixels |
| 02 | `mcp-hidden-tools-mobile-dark.png` | Height 565 → 564 at width 260; content shifts approximately one pixel. Both server/tool exposure selectors remain hidden, redaction and focus outline remain visible. 6,490 differing pixels | Minor geometry/rendering difference; same acceptance reservation as 01 |
| 03 | `mcp-hidden-tools-mobile-light.png` | Same one-pixel height reduction as 02, with the same labels, masking and exposure state. 8,591 differing pixels | Minor geometry/rendering difference; review separately from the dark baseline |
| 04 | `keyboard-mcp-desktop-dark.png` | Import panel 488 × 371 → 488 × 370. URL, focused textarea, explanatory text, unchecked option and Preview/Clear paste buttons remain present | Minor geometry/rendering difference, not evidence of a broken mobile-keyboard lifecycle; individual final-source decision needed |
| 05 | `keyboard-mcp-desktop-light.png` | Same one-pixel panel-height reduction as 04; content and focus state preserved | Minor geometry/rendering difference; separate light-baseline decision needed |
| 06 | `children-fr-dark-1280.png` | Same 448 × 523 panel and three child states. The single red-marked diff pixel is at (447, 3), on the upper-right outer border | Isolated border raster; propose accepting the reviewed border rendering, not weakening the screenshot assertion. Capture/raster cause remains unproven |
| 07 | `children-en-light-1280.png` | Same panel dimensions/content. Five red-marked pixels at (0, 3), (1, 3), (0, 4), (0, 5), (0, 6), all on the upper-left outer border | Isolated border raster; same reservation as 06 |
| 08 | `provider-model-lifecycle-tablet-dark.png` | New collapsed Prompt cache row moves provider cards/form and custom-model section downward; provider identity, usage and controls remain | Implemented UI change; accept or reject the additional row and resulting vertical layout explicitly |
| 09 | `workspace-files-desktop-light.png` | Explorer/tree, collision selector, linked-directory entry and file tab remain above the preview instead of a preview-only pane. Sidebar organisation/link controls and child-agent header control also appear | Implemented UI change; explicitly decide the retained explorer/tab layout and smaller preview area |
| 10 | `provider-model-lifecycle-tablet-light.png` | Prompt cache row and corresponding downward displacement, as in 08 | Implemented UI change; separate light-theme acceptance |
| 11 | `workspace-files-mobile-dark.png` | Explorer controls/tree plus README tab precede the preview; viewer header begins around y=366 instead of at the top. Markdown and bottom Mention/Copy/Download controls remain visible | Implemented UI change; mobile acceptance must include the substantial reduction in above-fold preview space |
| 12 | `workspace-files-mobile-light.png` | Same retained explorer/tab layout and reduced preview space as 11, in light theme | Implemented UI change; separate light-theme/mobile acceptance |
| 13 | `provider-model-lifecycle-desktop-light.png` | Prompt cache row shifts provider form downward; new workspace link/organisation controls appear in the sidebar | Implemented UI change; decide both provider-section and sidebar additions |
| 14 | `workspace-files-tablet-light.png` | Explorer controls/tree and README tab now share the pane with the preview, moving the preview downward; footer remains visible | Implemented UI change; tablet layout acceptance required |
| 15 | `session-lifecycle-mobile-light.png` | Workspace/session open controls, Linked directories and Organise navigation added. Generated title and nested branch remain; session rows move downward | Implemented UI change; accept the new navigation controls and spacing, not removal of lifecycle assertions |
| 16 | `provider-model-lifecycle-mobile-light.png` | Collapsed Prompt cache row adds about 30 pixels before the provider card. Form fields continue below the viewport; no field disappearance is demonstrated by this viewport capture | Implemented UI change; accept row/spacing explicitly, without claiming below-fold verification from the PNG |
| 17 | `provider-model-lifecycle-desktop-dark.png` | Prompt cache row and new sidebar controls, as in 13 | Implemented UI change; separate dark-theme acceptance |
| 18 | `provider-model-lifecycle-mobile-dark.png` | Prompt cache row and downward displacement, as in 16. Large solid field backgrounds amplify the diff; Playwright reports 81,028 pixels, not 81,028 missing controls | Implemented UI change; separate dark-theme/mobile acceptance |

## Source cross-check and limits

The frozen `EcosystemSettings.tsx:184` explicitly renders `CacheNoticeSettings`, whose collapsed summary is Prompt cache. This explains the six provider-screen additions without attributing them to capture timing. Frozen `Sidebar.tsx` renders linked-directory controls and the organisation disclosure. `WorkspacePanel.tsx` renders the explorer and open-file tabs, while `workspace-panel.css:56` reserves tree space with an open viewer. These explain the changed file/navigation layouts; implementation presence is **not** visual approval.

Existing owning tests are `e2e/{codemode,mcp-exposure,mobile-keyboard,subagent-lifecycle-live,visual}.spec.ts`. Assertions before a screenshot and the source inspection do not establish execution of assertions after that failed screenshot. In particular, this review does not credit later reload/persistence or child-agent restart controls. The child-panel capture already moves hover away and rounds the panel origin; the remaining corner pixels do not establish a new timing diagnosis.

Pre-existing presentation issues are not misclassified as new differences: the Settings heading partly under the mobile navigation toggle and desktop built-in-provider actions projecting left of their card are visible in both expected and actual captures. The review does not certify those existing layouts. No browser/font/toolchain explanation is proven for the five small metric changes or the two corner differences.

## Required decision and next gate

Recommendation: approve or reject the **11 enumerated feature/layout changes** individually, especially the four file-preview layouts; separately decide acceptance of the **seven minor rendering/border cases** after confirming the final-source rendering. No baseline update is authorized by this review. Any later approved update must be limited to reviewed images generated through Docker from the selected frozen source, without increasing tolerances or overwriting unrelated baselines.

Then run the complete same-source qualification matrix. Historical failures, native compiler failures, the remaining nonvisual browser cases and outstanding CI status remain separate. This review does not transfer historical results to current dirty sources or promote QUA-01/QUA-02.

Local evidence: `test-results/qua01-visual-review-20261101/` retains the 54 original PNGs, 18 comparison sheets, dimensions, hashes, source bindings, scripts and Docker analysis receipts. One initial border-analysis invocation used an unavailable daemon-side bind mount and failed MODULE_NOT_FOUND before decoding; its log is retained. The corrected copy-based invocation inspected the same PNGs without executing a browser test. Local nonversioned archive availability is not guaranteed indefinitely.
