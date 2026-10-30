# Completion and compactness QA

final result: passed

Target: user's updated rule—completion while collapsed is a thin one-sentence island, no overlapping display; closer task rows; content-driven height with the existing178pt cap. Earlier visual proposal remains the style reference; the new instruction supersedes its34pt row spacing and completion layout.

Evidence: three native captures (completion strip, one task, two tasks) taken from the resolved 432×178pt canvas. The PNGs are local QA artifacts and are not distributed with this repository. Captures are864×356px of the432×178pt native canvas at2x. The visible black region is smaller than the transparent canvas. Completion has a24pt text strip below38pt safe area (62pt total); one task96pt; two124pt. Tests verify the178pt cap for long content and many tasks.

Review:
- Typography/copy:13pt task names;12pt single-line completion phrase, no duplicate header, icon or running count in the toast.
- Spacing:28pt task rows with14pt side padding,8pt bottom margin; height shrinks when there are fewer rows. Completion text has its own narrow24pt region.
- Tokens/icons: existing black surface, green runtime dot, native chevrons; no new raster assets or gradients. Completion is text only.
- Content/interaction: a single mutually exclusive root branch shows completion/approval/tasks/compact state. Approval still suppresses other task information. A3-second real timer was verified in the process test; repeated mock completion input was used only to hold the visual state long enough for screenshot capture.
- Window/process identity: real helper integration test retains the same NSPanel window number and panelCount1 through multiple completion updates. Supervisor tests verify one child, coalesced restarts, waiting for old-child exit, late-event isolation and bounded retry budget.
- State race: a delayed title query after task completion cannot resurrect that session or generate another completion edge; the bridge integration test runs the actual bridge with a fake helper over real stdio.

50 native assertions and10 Node/integration tests passed. Screenshots show the requested thin single-sentence notice and smaller row spacing; no actionable P0/P1/P2 visual issue remains. Native focus and safe-area behavior are inherited from the previously verified panel. Only the helper supervisor and completion/state projection are reloaded; session data and approval policy are not changed.
