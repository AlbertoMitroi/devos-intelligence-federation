# Step 1b report: the lab on contract v1.2 generations

Date 2026-10-30. intelligence-federation 0.1.0 (main after `9c1159b`), contract `v1.2.0` vendored, system format `1.0`.
Inputs: the five lab generations regenerated with the contract v1.2 engines (dotnet-intelligence main 78121ab,
angular-intelligence main a7d8cdf), all `schemaVersion 1.2`; provenance and manifest digests in `tests/lab/README.md`.
Expectations: `tests/lab/expected-links.yml`, unchanged (written from the lab ground truth, Step 1).

## Result

**Precision 1.000, recall 1.000** on every kind with expectations; the system generation is `complete` (no input
defect left) and verifies.

| Kind | Expected | Found | Recall | Emitted | Matching | Precision |
|---|---|---|---|---|---|---|
| HTTP (configured_route) | 19 | 19 | 1.000 | 19 | 19 | 1.000 |
| dispatch (dispatches_to) | 0 | 0 | n/a | 0 | 0 | n/a |
| messaging (consumes_contract) | 2 | 2 | 1.000 | 2 | 2 | 1.000 |
| real time (pushes_to) | 2 | 2 | 1.000 | 2 | 2 | 1.000 |
| package (packages.ndjson: producer and version match) | 6 | 6 | 1.000 | 6 | 6 | 1.000 |

Package symbols (implemented_by_package): 105 links, 105 exact, 0 ambiguous, 0 candidate, 0 unresolved (a symbol the producer does not declare at its commit).

The lab has no in-process dispatch across repositories: every MediatR request and handler is inside lab-leasing (the
engine links those: 19 `exact`, 11 `candidate` from the test helper `FlowEngineTests.Send<T>(IRequest<T>)`). The only
send whose request type comes from a package is that test helper (`MediatR.IRequest\`1`, third-party), which is
excluded as test code. `dispatches_to` across inputs is covered by the unit test on the contract's rules.

## Package to source and version match

| Package | Consumed | Produced | Version match | Resolution | Symbols resolved |
|---|---|---|---|---|---|
| Pricing.Client (Leasing.Pricing, central version) | 1.1.0 | 1.1.0 | exact | exact | 12/12 |
| **Pricing.Client (tools/Leasing.QuoteBackfill, VersionOverride)** | **1.0.0** | **1.1.0** | **different** | exact | 5/5 |
| Lab.Core.Clients.Pricing | 1.0.0 | 1.0.0 | exact | exact | 5/5 |
| Lab.Core.Workflow.EventFlow | 1.0.0 | 1.0.0 | exact | exact | 70/70 |
| Lab.Core.Transform.Bpmn | 1.0.0 | 1.0.0 | exact | exact | 9/9 |
| Lab.Core.MessageHubs | 1.0.0 | 1.0.0 | exact | exact | 4/4 |

The deliberate mismatch is reported: the backfill tool consumes `Pricing.Client` 1.0.0 while lab-pricing produces 1.1.0
at commit `0ee03cc9eb17`; its call `GetQuoteAsync` still resolves (the method exists at 1.1.0), and the link carries
`versionMatch: different` with both versions. Gate 3 is met.

## Misses and false positives

None. Five matched links are not `exact`; each names its cause:

| Link | Resolution | Cause | Owner |
|---|---|---|---|
| leasing `QuotePricingService` → `Lab.Core.Clients.Pricing.GetRateCardAsync` → pricing `GET /api/rate-cards/{}` | candidate | the call is `candidate` in the lab-core generation (URL built from the product code parameter) | dotnet engine |
| leasing `QuotePricingService.RepriceAsync` → `Pricing.Client.RecalculateQuoteAsync` → `POST /api/quotes/{}/recalculate` | candidate | the call is `candidate` in the lab-pricing generation (URL built with the quote id) | dotnet engine |
| backfill → `Pricing.Client.GetQuoteAsync` 1.0.0 → `GET /api/quotes/{}` | candidate | same cause as above; also `versionMatch: different` | dotnet engine |
| leasing `FlowProjectionService.Project` (`SendToAll("flowUpdated")`) → web `flowUpdated` | candidate | the method now comes from the `call.argument` record (exact) and the hub from `realtime.connection` (route `/hubs/leasing`); what is left is the subscription's own resolution in the web generation: "the connection is not built in a field or variable of this context; it is assumed to be the only hub connection the context builds" | angular engine |
| leasing `FlowProjectionService.Project` (`SendToSpecifiedUsers(..., "taskAssigned")`) → web `taskAssigned` | candidate | same as above | angular engine |

Compared with Step 1 (v1.1 inputs): the two real-time false positives are gone (call-site values pair each send with
its subscription), all six package resolutions are `exact` with the right version match, and lab-leasing's input defects
are gone.

## Traces

34 traces, all `candidate`: 12 web → leasing → web (HTTP call, flow engine, `FlowEventsAppended`, projection, SignalR
push), 14 web → leasing → pricing, 4 intake → leasing → pricing, 4 intake → leasing → web. MediatR steps are now
`exact` dispatches; the `candidate` segment in every trace is the flow engine's call to a workflow plugin, which the
engine records as `possible_runtime_target` (the plugin is chosen by class-name convention at run time). The ground
truth does not enumerate traces, so trace precision is not measured.

## eShopOnAbp on its regenerated v1.2 generations

Precision 1.000, recall 1.000 (17/17 HTTP links, all `candidate` for the two recorded reasons of Step 1: the Angular
production environment lacks `apis.Catalog.url` / `apis.Ordering.url`, and ABP auto API endpoints are conventional).
Two messages are unresolved (no subscriber in the system): `ProductStockCountChangedEto`, `EntityDeletedEto`. The system
status is `partial` because the dotnet input itself is `partial`.

## Checks

| Check | Result |
|---|---|
| Unit tests | 11 pass |
| `scripts/verify.sh` on the new fixture | ok: two runs byte-identical (and identical to the run on the host), verify ok, evaluation now gated on precision 1.000, recall 1.000, every expected unresolved link and every package with its expected version match |
| CI (amd64, arm64, cross-architecture comparison, actionlint) | see the run of the merge commit |
