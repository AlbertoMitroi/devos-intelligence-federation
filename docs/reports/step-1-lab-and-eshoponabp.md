# Step 1 report: lab system and eShopOnAbp

Date 2026-10-30. intelligence-federation 0.1.0, system format `1.0-proposal`, contract schemas vendored at
`devos-intelligence-contract` `ea4975a`.

## What was run and checked

| Check | Result | How |
|---|---|---|
| Unit tests (7) | pass | `node --test tests/unit/*.test.ts`, also in the Docker test stage |
| Lab system generation verifies | **ok** (status `partial`, see below) | `verify` with the inputs' manifest digests, in `scripts/verify.sh` |
| Determinism | two runs byte-identical (only `run.json` differs), `index.sqlite` byte-identical too, dumps identical; host Node 26 and image Node 24 give the same bytes | `scripts/verify.sh`, `diff -r` |
| Action mode | outputs written, output owned by the workspace owner | `scripts/verify.sh` (simulated workspace) |
| eShopOnAbp system generation verifies | **ok** (status `partial`) | `verify`, local only |
| CI on amd64 and arm64, byte comparison across architectures | pass: run 41022234231 on 11b463d (verify.sh and the Action on both architectures, amd64 and arm64 system generations byte-identical, actionlint) | `.github/workflows/ci.yml` |

Not checked: repository blob ids (the repositories are not mounted), the published image and Action (no release yet),
OCI inputs (not supported).

### Inputs

Lab: the five generations in `tests/lab/generations.tar.gz` (table in `tests/lab/README.md`), `tests/lab/system.yml` (copy
of `devos-lab/system.yml`). All five pass verification; `leasing` has input defects that are reported and kept:
a repository-scope analysis context for project `.` with no project record, and 13 observations naming that project.
The system status is `partial` because of those defects.

eShopOnAbp: `_generations/eshoponabp-angular` (manifest sha256 `abe76b33c055f50f…`) and `_generations/eshoponabp-dotnet`
(`12585a769976e859…`), both at `7bfed7a`, with `systems/eshoponabp/system.yml`. The dotnet input is itself `partial`
and has one dangling reference (an observation naming `Volo.Abp...EntityDeletedEto\`1`, a package entity with no entity
record). Not committed as fixtures (the dotnet generation alone is 39 MB); run locally.

## Lab: cross-repository links

Expectations: `tests/lab/expected-links.yml`, transcribed by hand from the lab repositories' `ground-truth.yml`
(items `web-http-calls`, `web-realtime-subscribe`, `leasing-pricing-calls`, `leasing-kafka-consumers`,
`leasing-kafka-producer`, `leasing-bus-messages`, `leasing-lab-packages`) and the comments of `system.yml`.

## Totals (lab)

- Precision **0.920** (23 of 25 resolved links match an expected link); precision of exact links 1.000.
- Recall **1.000** (23 of 23 expected links found).

| Via | Expected | Found | Recall | Emitted | Matching | Precision |
|---|---|---|---|---|---|---|
| http | 19 | 19 | 1.000 | 19 | 19 | 1.000 |
| messaging | 2 | 2 | 1.000 | 2 | 2 | 1.000 |
| realtime | 2 | 2 | 1.000 | 4 | 2 | 0.500 |

| Resolution | Emitted | Matching |
|---|---|---|
| exact | 17 | 17 |
| ambiguous | 0 | 0 |
| candidate | 8 | 6 |

### Expected links

| Expected | Ground truth | Found | Resolution |
|---|---|---|---|
| web-applications-search | lab-web/web-http-calls | yes | exact |
| web-applications-get | lab-web/web-http-calls | yes | exact |
| web-applications-review | lab-web/web-http-calls | yes | exact |
| web-applications-withdraw | lab-web/web-http-calls | yes | exact |
| web-assessments-list | lab-web/web-http-calls | yes | exact |
| web-assessments-assess | lab-web/web-http-calls | yes | exact |
| web-quotes-list | lab-web/web-http-calls | yes | exact |
| web-quotes-get | lab-web/web-http-calls | yes | exact |
| web-quotes-accept | lab-web/web-http-calls | yes | exact |
| web-quotes-recalculate | lab-web/web-http-calls | yes | exact |
| web-leases-search | lab-web/web-http-calls | yes | exact |
| web-leases-get | lab-web/web-http-calls | yes | exact |
| web-leases-document | lab-web/web-http-calls | yes | exact |
| web-leases-sign | lab-web/web-http-calls | yes | exact |
| web-portfolio-summary | lab-web/web-http-calls | yes | exact |
| leasing-rate-card | lab-leasing/leasing-pricing-calls | yes | candidate |
| leasing-calculate-quote | lab-leasing/leasing-pricing-calls | yes | candidate |
| leasing-recalculate-quote | lab-leasing/leasing-pricing-calls | yes | candidate |
| backfill-get-quote | lab-leasing/leasing-pricing-calls | yes | candidate |
| kafka-applications | lab-leasing/leasing-kafka-consumers | yes | exact |
| kafka-enrichment | lab-leasing/leasing-kafka-consumers | yes | exact |
| signalr-flow-updated | lab-web/web-realtime-subscribe | yes | candidate |
| signalr-task-assigned | lab-web/web-realtime-subscribe | yes | candidate |

### Misses (expected, not found)

None.

### False positives (emitted, not expected)

- realtime candidate: leasing:leasing/dotnet:src/Leasing.AppServices/Leasing.AppServices.csproj:M:Leasing.AppServices.Projections.FlowProjectionService.Project(System.Guid,System.Threading.CancellationToken) → web:web/ts:.:src/app/core/realtime/leasing-hub.service#LeasingHubService. Reason recorded: the client does not record the hub route; the only route from web in system.yml leads to leasing; the client method name is an argument of the package method at the call site and is not recorded; subscription in web: the connection is not built in a field or variable of this context; package: the producing generation has no packageId for src/Lab.Core.MessageHubs/Lab.Core.MessageHubs.csproj; matched by assembly name Lab.Core.MessageHubs; the producing generation has no package version for src/Lab.Core.MessageHubs/Lab.Core.MessageHubs.csproj
- realtime candidate: leasing:leasing/dotnet:src/Leasing.AppServices/Leasing.AppServices.csproj:M:Leasing.AppServices.Projections.FlowProjectionService.Project(System.Guid,System.Threading.CancellationToken) → web:web/ts:.:src/app/core/realtime/leasing-hub.service#LeasingHubService. Reason recorded: the client does not record the hub route; the only route from web in system.yml leads to leasing; the client method name is an argument of the package method at the call site and is not recorded; subscription in web: the connection is not built in a field or variable of this context; package: the producing generation has no packageId for src/Lab.Core.MessageHubs/Lab.Core.MessageHubs.csproj; matched by assembly name Lab.Core.MessageHubs; the producing generation has no package version for src/Lab.Core.MessageHubs/Lab.Core.MessageHubs.csproj

### Links with a non-exact resolution among the matches

- leasing-rate-card: candidate. the call is candidate in core; package: the producing generation has no packageId for src/Lab.Core.Clients.Pricing/Lab.Core.Clients.Pricing.csproj; matched by assembly name Lab.Core.Clients.Pricing; the producing generation has no package version for src/Lab.Core.Clients.Pricing/Lab.Core.Clients.Pricing.csproj
- leasing-calculate-quote: candidate. package: the producing generation has no packageId for src/Pricing.Client/Pricing.Client.csproj; matched by assembly name Pricing.Client; the producing generation has no package version for src/Pricing.Client/Pricing.Client.csproj
- leasing-recalculate-quote: candidate. the call is candidate in pricing; package: the producing generation has no packageId for src/Pricing.Client/Pricing.Client.csproj; matched by assembly name Pricing.Client; the producing generation has no package version for src/Pricing.Client/Pricing.Client.csproj
- backfill-get-quote: candidate. the call is candidate in pricing; package: the producing generation has no packageId for src/Pricing.Client/Pricing.Client.csproj; matched by assembly name Pricing.Client; the producing generation has no package version for src/Pricing.Client/Pricing.Client.csproj
- signalr-flow-updated: candidate. the client does not record the hub route; the only route from web in system.yml leads to leasing; the client method name is an argument of the package method at the call site and is not recorded; subscription in web: the connection is not built in a field or variable of this context; package: the producing generation has no packageId for src/Lab.Core.MessageHubs/Lab.Core.MessageHubs.csproj; matched by assembly name Lab.Core.MessageHubs; the producing generation has no package version for src/Lab.Core.MessageHubs/Lab.Core.MessageHubs.csproj
- signalr-task-assigned: candidate. the client does not record the hub route; the only route from web in system.yml leads to leasing; the client method name is an argument of the package method at the call site and is not recorded; subscription in web: the connection is not built in a field or variable of this context; package: the producing generation has no packageId for src/Lab.Core.MessageHubs/Lab.Core.MessageHubs.csproj; matched by assembly name Lab.Core.MessageHubs; the producing generation has no package version for src/Lab.Core.MessageHubs/Lab.Core.MessageHubs.csproj

### Unresolved links (messages leaving the system)

| Expected | Ground truth | Found | Reason |
|---|---|---|---|
| kafka-contracts-out | lab-leasing/leasing-kafka-producer | yes | no subscriber in the system for Lab.Leasing.Contracts.LeaseContractActivated on topic leasing-contracts-v1 (kafka); the consumer may be outside the system |
| bus-notice-outbox | lab-leasing/leasing-bus-messages | yes | no subscriber in the system for Leasing.AppServices.Messaging.PendingNoticeAddedToOutbox on an unknown destination (azure-service-bus, rabbitmq); the consumer may be outside the system |

### Package to source

| Expected | Producer | Version match (expected) | Resolution | Result |
|---|---|---|---|---|
| pricing-client-current | pricing | unknown (exact) | candidate | **miss** |
| pricing-client-older | pricing | unknown (different) | candidate | **miss** |
| core-clients-pricing | core | unknown (exact) | candidate | **miss** |
| core-workflow | core | unknown (exact) | candidate | **miss** |
| core-bpmn | core | unknown (exact) | candidate | **miss** |
| core-message-hubs | core | unknown (exact) | candidate | **miss** |

### Every miss and false positive, with its cause

| Item | Kind | Cause | Owner of the fix |
|---|---|---|---|
| Two real-time links `FlowProjectionService.Project` → `taskAssigned` (via `SendToAll`) and → `flowUpdated` (via `SendToSpecifiedUsers`) | false positive (candidate) | The client method name is the first argument of `IMessageHubUtility.SendToAll(string method, ...)` in lab-core; lab-leasing passes the literal at the call site, but no record carries call-site argument values, so every send on the hub matches every subscription. Both correct pairs are found too, also `candidate`. | dotnet engine (record argument values used as destinations, proposal rule 4) |
| All six package resolutions: `versionMatch` `unknown` instead of `exact` / `different`; resolution `candidate` | miss (gate 3) | The lab-core and lab-pricing generations have `packageId`, `packageVersion` and `isPackable` null for every project (eShopOnAbp's generation has them), with no diagnostic. Federation falls back to the assembly name and cannot compare versions, so the deliberate `Pricing.Client` 1.0.0 (tools/Leasing.QuoteBackfill) vs 1.1.0 mismatch is not shown. With the fields present (unit test `federation links HTTP, package calls with version mismatch`) the resolution is `exact` and the mismatch is reported as `different`. | dotnet engine; reported to the coordinator on 2026-10-30 |
| Four leasing → pricing HTTP links are `candidate`, not `exact` | weaker resolution, not a miss | The package fallback above, plus `GetQuoteAsync`, `RecalculateQuoteAsync` and `GetRateCardAsync` are `candidate` calls in their own generations (the URL is built with a parameter). | dotnet engine data; resolves with the regeneration |
| Two SignalR links are `candidate` | weaker resolution | The Angular generation leaves `realtime.subscribe.route` empty and keeps the hub path in `realtime.connection`, a v1.2 proposal kind that a v1.1 consumer must not link on; federation reaches the hub through the only route from `web` in `system.yml`. | contract (accept the kind or a route on the subscription) |

What contract v1.2 would buy for SignalR (kept to v1.1 on the coordinator's instruction, 2026-10-30): with
`realtime.connection` accepted, the two `web` subscriptions would reach `/hubs/leasing` through the client's own
`environment.apiUrl` + `environment.hubPath` instead of the single-route fallback, removing one of the two `candidate`
causes of `signalr-flow-updated` and `signalr-task-assigned`. The two false positives stay until the dotnet engine
records the method-name argument at the `IMessageHubUtility` call sites; v1.2 alone does not remove them.

When the regenerated lab-core and lab-pricing generations carry `packageId` and `packageVersion`, the expected result is
`exact` resolutions for all six packages and `versionMatch: different` for `Pricing.Client` 1.0.0; the unit test
`federation links HTTP, package calls with version mismatch` checks that path today on synthetic generations.

Gate 4 on the lab: every HTTP call of lab-web reaches its lab-leasing endpoint (15/15 exact); every pricing client
call reaches its lab-pricing endpoint (4/4, candidate); both Kafka records reach their consumer (2/2 exact); the Kafka
topic `leasing-contracts-v1` and the bus queue `notice-outbox` are unresolved with the reason; both SignalR subscriptions
reach the sender (candidate, with two extra candidates). Gate 3 is **not met** on the lab data (version match unknown).

### Traces

42 traces, all `candidate`: 24 web → leasing → web (an HTTP call whose handler reaches the flow engine, the internal
`FlowEventsAppended` message, `FlowProjectionService.Project` and the SignalR push), 14 web → leasing → pricing and 4
intake → leasing → pricing (Kafka consumer → `StartFlowCommand` → flow engine → plugin → `QuotePricingService` →
package client → Pricing.Api). The candidate segment is always the flow engine's call to a plugin: the engine records
those as `possible_runtime_target` (any plugin implementation), so a trace says a path is possible, not that a given
request takes it (for example web `QuotesService.recalculate` reaches both `QuotesController.Recalculate` and
`QuotesController.Calculate` of Pricing.Api). The chain the ground truth states (`leasing-pricing-calls`:
`RecalculateActionHandler` → `QuotePricingService.RepriceAsync` → Pricing.Client `RecalculateQuoteAsync` → `POST
api/quotes/{id}/recalculate`) is present. The ground truth does not enumerate traces, so trace precision is not
measured.

## eShopOnAbp: Angular and .NET generations of the same commit

Expectations: `tests/eshoponabp/expected-links.yml`, written from source at `7bfed7a` (the 17 generated Angular
proxy calls and the ABP application services exposed as conventional controllers).

## Totals (eshoponabp)

- Precision **1.000** (17 of 17 resolved links match an expected link); precision of exact links n/a.
- Recall **1.000** (17 of 17 expected links found).

| Via | Expected | Found | Recall | Emitted | Matching | Precision |
|---|---|---|---|---|---|---|
| http | 17 | 17 | 1.000 | 17 | 17 | 1.000 |

| Resolution | Emitted | Matching |
|---|---|---|
| exact | 0 | 0 |
| ambiguous | 0 | 0 |
| candidate | 17 | 17 |

### Misses (expected, not found)

None.

### False positives (emitted, not expected)

None.

### Links with a non-exact resolution among the matches

- public-product-get: candidate. the call is candidate in angular: environment key 'environment.apis.Catalog.url' is missing in 1 of 2 environment file(s) of the including applications (apps/angular/src/environments/environment.prod.ts); the endpoint is candidate in dotnet (abp-auto-api)
- public-product-list: candidate. the call is candidate in angular: environment key 'environment.apis.Catalog.url' is missing in 1 of 2 environment file(s) of the including applications (apps/angular/src/environments/environment.prod.ts); the endpoint is candidate in dotnet (abp-auto-api)
- product-create: candidate. the call is candidate in angular: environment key 'environment.apis.Catalog.url' is missing in 1 of 2 environment file(s) of the including applications (apps/angular/src/environments/environment.prod.ts); the endpoint is candidate in dotnet (abp-auto-api)
- product-delete: candidate. the call is candidate in angular: environment key 'environment.apis.Catalog.url' is missing in 1 of 2 environment file(s) of the including applications (apps/angular/src/environments/environment.prod.ts); the endpoint is candidate in dotnet (abp-auto-api)
- product-get: candidate. the call is candidate in angular: environment key 'environment.apis.Catalog.url' is missing in 1 of 2 environment file(s) of the including applications (apps/angular/src/environments/environment.prod.ts); the endpoint is candidate in dotnet (abp-auto-api)
- product-list: candidate. the call is candidate in angular: environment key 'environment.apis.Catalog.url' is missing in 1 of 2 environment file(s) of the including applications (apps/angular/src/environments/environment.prod.ts); the endpoint is candidate in dotnet (abp-auto-api)
- product-list-paged: candidate. the call is candidate in angular: environment key 'environment.apis.Catalog.url' is missing in 1 of 2 environment file(s) of the including applications (apps/angular/src/environments/environment.prod.ts); the endpoint is candidate in dotnet (abp-auto-api)
- product-update: candidate. the call is candidate in angular: environment key 'environment.apis.Catalog.url' is missing in 1 of 2 environment file(s) of the including applications (apps/angular/src/environments/environment.prod.ts); the endpoint is candidate in dotnet (abp-auto-api)
- order-create: candidate. the call is candidate in angular: environment key 'environment.apis.Ordering.url' is missing in 1 of 2 environment file(s) of the including applications (apps/angular/src/environments/environment.prod.ts); the endpoint is candidate in dotnet (abp-auto-api)
- order-get: candidate. the call is candidate in angular: environment key 'environment.apis.Ordering.url' is missing in 1 of 2 environment file(s) of the including applications (apps/angular/src/environments/environment.prod.ts); the endpoint is candidate in dotnet (abp-auto-api)
- order-by-order-no: candidate. the call is candidate in angular: environment key 'environment.apis.Ordering.url' is missing in 1 of 2 environment file(s) of the including applications (apps/angular/src/environments/environment.prod.ts); the endpoint is candidate in dotnet (abp-auto-api)
- order-dashboard: candidate. the call is candidate in angular: environment key 'environment.apis.Ordering.url' is missing in 1 of 2 environment file(s) of the including applications (apps/angular/src/environments/environment.prod.ts); the endpoint is candidate in dotnet (abp-auto-api)
- order-list-paged: candidate. the call is candidate in angular: environment key 'environment.apis.Ordering.url' is missing in 1 of 2 environment file(s) of the including applications (apps/angular/src/environments/environment.prod.ts); the endpoint is candidate in dotnet (abp-auto-api)
- order-my-orders: candidate. the call is candidate in angular: environment key 'environment.apis.Ordering.url' is missing in 1 of 2 environment file(s) of the including applications (apps/angular/src/environments/environment.prod.ts); the endpoint is candidate in dotnet (abp-auto-api)
- order-orders: candidate. the call is candidate in angular: environment key 'environment.apis.Ordering.url' is missing in 1 of 2 environment file(s) of the including applications (apps/angular/src/environments/environment.prod.ts); the endpoint is candidate in dotnet (abp-auto-api)
- order-set-as-cancelled: candidate. the call is candidate in angular: environment key 'environment.apis.Ordering.url' is missing in 1 of 2 environment file(s) of the including applications (apps/angular/src/environments/environment.prod.ts); the endpoint is candidate in dotnet (abp-auto-api)
- order-set-as-shipped: candidate. the call is candidate in angular: environment key 'environment.apis.Ordering.url' is missing in 1 of 2 environment file(s) of the including applications (apps/angular/src/environments/environment.prod.ts); the endpoint is candidate in dotnet (abp-auto-api)


All 17 links are `candidate` for two recorded reasons: the Angular calls are `candidate` in their generation (the
production environment file lacks `apis.Catalog.url` / `apis.Ordering.url`), and the endpoints are `candidate`
(ABP auto API controllers, routes derived by convention). Two messages published in eShopOnAbp have no subscriber
anywhere in the system and are listed as unresolved, as the plan requires: `ProductStockCountChangedEto` and the
framework's `EntityDeletedEto`; publishes with a subscriber inside the dotnet input are left to the engine. No ground
truth was written for messaging here, so those two are not scored.

## What is not done

- Gate 3 on the lab waits for regenerated lab-core and lab-pricing generations with `packageId` and `packageVersion`.
- The system generation format is a proposal (`docs/SYSTEM-GENERATION.md`), not yet in the contract.
- OCI inputs, wiki pages, workflow links across inputs (no generation emits `workflow.handler`).

## Addendum: contract v1.2.0 (2026-10-30, same day)

The federation now vendors `devos-intelligence-contract` `v1.2.0` (`schema/v1` with `kinds/`, `schema/system/v1`,
`schema/index/v1`), emits `schemaVersion: 1.2` and `systemFormat: 1.0`, builds `index.sqlite` from the contract's
`index.sql` (sections base and system, `meta` with `commit`, `indexSchema`, `status`, `coverage`, `generationType`,
`system`, `systemFormat`, `configurationHash`), places observations at their `site`, links real time through
`realtime.connection` with case-insensitive method names, substitutes `call.argument` values (C7) and emits
`dispatches_to` across inputs (C8).

| Check | Result |
|---|---|
| Unit tests | 11 pass, 4 new on the contract's examples: the SignalR pair `flowUpdated` / `taskAssigned` through `IMessageHubUtility` with call-site values and a lower-case subscription gives exactly two `exact` links (four `candidate` links without the values); dispatch across inputs gives `exact`, `ambiguous`, `unresolved` and `candidate` as rules 2 to 4 say; substituted routes are canonicalized |
| `scripts/verify.sh` on the lab fixture | ok: two runs byte-identical, verify ok, precision 0.920, recall 1.000 (unchanged) |
| eShopOnAbp | verify ok, precision 1.000, recall 1.000 (unchanged) |

The lab numbers do not move yet because the inputs are still v1.1: the web generation's `realtime.connection` has no
route (`{environment.hubPath}`), no input carries `call.argument` or `site`, and lab-core and lab-pricing still lack
`packageId`. The `.NET` generations in `_generations/` were rewritten at 10:17 (new lab commits, `wiki/` and
`index.sqlite` added); they still have no `packageId`, and federating them gives the same precision and recall. The
evaluation is rerun when the coordinator announces the regenerated generations.
