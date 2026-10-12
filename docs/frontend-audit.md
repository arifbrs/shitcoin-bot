# Frontend audit — 12 October 2026

Scope: React dashboard, lane navigation, stream lifecycle, data presentation, accessibility, and frontend quality checks.

## Findings addressed

| Finding | Change |
| --- | --- |
| The header's feed badge followed legacy Solana process health rather than the dashboard connection. | Connection status now follows valid SSE snapshots. Lane health stays separate; disconnected or old snapshots cannot show verified active lanes. |
| A closed EventSource was treated as an expired session, including server failures. | Verify HTTP 401 before redirecting. Retry terminal connections with bounded backoff, retain the last snapshot, and expose manual reconnect. Abort pending checks and ignore old callbacks after reconnect/unmount. |
| Invalid stream frames were silently ignored. | Show an explicit update error while retaining the last valid snapshot. |
| No visible snapshot age or global connection-loss warning. | Display receipt age, reconnect state, and a warning after 90 seconds without a new snapshot. The timer advances even when frames stop arriving. This is snapshot freshness, not a transport heartbeat check. |
| All lanes and dozens of small variant cards competed on one page. | Add an overview, per-lane navigation, operational metrics, lane health cards, and Robinhood paper activity. Detail panels mount only when selected. |
| Robinhood variants were difficult to locate and read. | Search by variant, cohort, or token; filter to open positions; increase type sizes and card spacing. |
| Header controls and layout were cramped on small screens. | Add responsive layout, horizontal lane navigation, labeled controls, visible keyboard focus, skip navigation, and reduced-motion styling. Execution mode remains visible on mobile. |
| Diagnostics could hide the loading screen before data arrived, with no dialog to close. | Disable diagnostics until a snapshot is available. |
| FeelingAgent inserted streamed text using innerHTML. | Build the speech text and cursor with textContent and DOM nodes. |
| Chart styles used raw HTML injection. | Render style text through React children. |
| OKX paused-source rendering relied on an unsafe optional-chain cast. | Narrow source rows before reading their source property. |
| The mode regression test expected an obsolete English empty-state label. | Assert the component's existing Indonesian live-position message. |

## Data behavior retained

- No execution controls, trading parameters, wallet operations, or backend modes were changed.
- Solana panels still use the existing live/paper adapter. Global stall warnings remain visible outside the Solana tab.
- Missing overview values display an em dash. Paper results are labeled and are not added to real-wallet balances.
- Robinhood, DexScreener, and OKX paper still receive SSE snapshots. GMGN and OKX Web3 retain their existing periodic refresh and mount only when their lane is selected.
- The dark graphite/mint theme is scoped to the dashboard; landing and login retain their existing styling.

## Verification

- `npm --prefix web run build`: passed, including TypeScript compilation.
- `npm --prefix web run dashboard:check`: 10 tests passed. Covers invalid frames, native and terminal retries, confirmed 401, stale callbacks, cleanup, search, missing data, and stale status rendering.
- `npm --prefix web run mode:check`: passed, including paper/live isolation and execution-lock checks.
- `npm --prefix web run panel:check`: passed using the available local stats fixture.
- `npm --prefix web run poscard:check`: passed.
- `npm --prefix web run lint`: completed with pre-existing warnings in legacy components; no lint errors.
- Language-server diagnostics were requested for edited source files. Some returned no errors; several timed out. The full TypeScript build passed.
- `web/e2e/dashboard.yaml` passed Sokudo schema validation. Browser execution was blocked because the workspace Browser panel/tab was unavailable. No visual, mobile, keyboard, or browser E2E pass is claimed. Open the Browser panel and sign into the local app before running this flow.

## Remaining audit findings

`npx --yes aislop@latest scan . --include 'web/src/**' --json` improved from **77 to 84/100**. The final scan covers 61 supported files and reports **0 errors, 21 warnings, 3 informational findings**, with no fixable warnings. Scan exit code: 0.

- Legacy components still have long functions or deep nesting: ControlDialog, DiagnosticsDialog, FeelingAgent, PipelineFlow, PositionCard, BandWatch, HeroWave, and PipelineFunnel. A larger refactor needs separate regression coverage for their interactions.
- Existing type escapes in `liveView.ts` and `panelMemo.ts`, duplicate markup in the UI card primitives, and the size of `stats.ts` remain maintainability findings.
- The scanner reports dependency warnings for transitive `stream-json` and `uuid`, plus informational findings for dev-only dependencies. Its suggested Solana parent version is not an upgrade from the installed version; dependency changes require separate compatibility review and were not applied mechanically.
- The installed Node 20.17.0 is below the minimum requested by Vite (20.19+ or 22.12+). This build succeeded, but the runtime should be updated separately.
- The new visual layout still needs browser inspection at desktop and mobile widths; its responsive behavior has only been checked in source and compilation in this session.
