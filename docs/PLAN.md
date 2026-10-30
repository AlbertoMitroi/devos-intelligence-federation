# intelligence-federation: plan

Step 0 wrote the plan; Step 1 (this revision, 2026-10-30) refines it against what the engines emit now and implements
it. Changes from Step 0 are listed in "Refinements" at the end.

## Why a separate product

Each engine analyses one repository (the dotnet prompt puts cross-repository linking out of its scope). A real system spans repositories: an Angular front end, a backend that consumes another team's API through a client NuGet package, and services that talk over Kafka and RabbitMQ. Federation works only on generations, never on source, so it is technology-neutral and runs anywhere the generations are.

Rules from the dotnet prompt that carry over: Docker-first, CI-native (Action + `docker run`), artifacts only, determinism (same inputs and configuration give byte-identical output), evidence on every link, unknown is not empty, no invented results, no built-in knowledge of any repository.

## Inputs

`system.yml`, supplied by the caller (the lab's is `devos-lab/system.yml`):

```yaml
system: lab
generations:
  - name: web                            # input name: ^[a-z0-9][a-z0-9-]*$, prefixes every record of that input
    path: generations/lab-web            # relative to system.yml; `--input web=<dir>` replaces it
  - name: leasing
    path: generations/lab-leasing        # (oci: ghcr.io/org/context-web@sha256:... is reserved, not supported yet)
routes:                                  # how a caller reaches a service, when the generations cannot tell
  - from: web
    baseUrl: environment.apiUrl          # configuration key (or literal value) seen in the caller's generation
    to: leasing
messaging:
  contractIdentity: typeName             # or entity, or destination
```

Only the NDJSON files and `manifest.json` of an input are read (the contract); an input's own `index.sqlite` is never needed.

## Pipeline

1. **Verify inputs**: manifest schema, major 1, known required capabilities, checksums, unlisted files, record schemas, sorted unique ids. A structural failure excludes the input; dangling references inside an input (an id naming no record) are reported as input defects and the input is still used. Every input gets an `inputs.ndjson` record with the outcome.
2. **Inventory** (`inputs.ndjson`): repository, commit, dirty flag, engine and version, image digest, schema version, status, manifest sha256, verification result.
3. **Package to source**: for every `dotnet:pkg:{id}@{version}:{assembly}:{docId}` entity used by one input, find the input whose project has `packageId == id` (contract v1.1) and resolve the symbol to `dotnet:{project}:{docId}`. When the producing generation has no `packageId` (seen in the lab generations of 2026-10-30), fall back to the non-test project whose assembly name equals the package id and the package's assembly, with resolution `candidate` and the reason. `versionMatch`: `exact` when the producing project's `packageVersion` equals the consumed version, `different` with both versions, `unknown` when the producer has no version. Same for `ts:pkg:` and `npmName`/`npmVersion`. Records: `graph/packages.ndjson` (one per consumer, package and version) and one `implemented_by_package` link per package symbol used.
4. **Cross-repository links**, from normalized fields only (v1.1 kinds; unknown kinds such as `realtime.connection` or `ui.*` are kept and never linked):
   - HTTP: `http.call` to `http.endpoint` of another input. The target inputs come from `routes` whose `baseUrl` is the call's `baseAddress.key` (or one of its values); without a route, every other input is searched and the link is at most `candidate`. Method, then canonical route with route precedence (most literal segments; a call parameter against an endpoint literal is `candidate`); a base address path is prepended when the configured URL has one. A call reached through a package (consumer call site → package symbol → producer source → implementations → bounded calls → `http.call`) is attributed to the consumer's call site and routed with the consumer's routes.
   - Messaging: publish to subscribe across inputs by contract identity, then transport and destination when both sides know them. A publish with a subscriber of the same contract in its own input, or with an engine link there, is internal (the engine owns it). A publish with no subscriber anywhere in the system is kept as `unresolved` with the reason (the consumer may be outside the system); in-memory transports are left out.
   - Real time: `realtime.send` (direct or through a package) to `realtime.subscribe` by hub route and method name. A subscription without a route reaches the hubs of the only input its routes lead to (`candidate`); a send without a method name matches every subscription on the hub (`candidate`, reason recorded).
   - Workflow across inputs: no input emits `workflow.handler` yet; deferred (see Refinements).
   - Test projects (a project whose packages include a test SDK) are never a source of cross-repository links; their sites are counted in diagnostics.
5. **Traces**: chains of two or more cross-repository links, joined inside the input between them by a breadth-first path (at most 8 steps) over calls, implementations of called members, possible runtime targets and the input's own `dispatches_to` links. Each segment keeps its resolution and evidence; the trace takes the weakest and records which segment it is.
6. **Artifacts**: the union of the inputs' records with prefixed ids, the system links, `inputs.ndjson`, `graph/packages.ndjson`, `graph/traces.ndjson`, system diagnostics, `index.sqlite` over the union (same tables and columns as the engines' index, plus `inputs`, `packages`, `traces`), context packs (overview, service map with Mermaid, one card per repository, one per message contract or real-time method, traces) and `manifest.json` written last. Format: [SYSTEM-GENERATION.md](SYSTEM-GENERATION.md) (a proposal for the contract owner).

## Identity

Records keep their input's ids, prefixed with the input name (`leasing/rel:...`, `leasing/dotnet:src/...`); every reference inside a record is prefixed the same way and the record gains `input`. Paths stay repository-relative. A system link (`scope: system`) has its own `lnk:` id over its identifying fields; package resolutions use `pkr:`, traces `trc:`.

## Steps, requirements and gates

| Step | Requirement | Where | Check | Status |
|---|---|---|---|---|
| 1 | CLI `federate`, `verify`, `evaluate`, `dump-index`, `version`, `gha` | `src/cli.ts`, `src/gha.ts` | unit tests, `scripts/verify.sh` | done |
| 1 | Docker image (test, runtime, action), Action, CI on amd64 and arm64 with byte comparison | `Dockerfile`, `action.yml`, `.github/workflows/ci.yml` | CI | done |
| 2 | Input verification, inventory, failing inputs reported and excluded | `src/input.ts`, `src/generation.ts` | unit test (tampered input) | done |
| 3 | Package to source with version matching | `src/packages.ts` | unit test (1.0.0 vs 1.1.0), lab report | done; lab blocked on engine data (no `packageId` in lab-core and lab-pricing generations) |
| 4 | Cross-repository links and traces | `src/links.ts`, `src/traces.ts` | lab evaluation | done |
| 4 | `index.sqlite` over the union, deterministic dump | `src/sqlite.ts` | two runs, dump compared | done |
| 4 | System context packs, manifest last | `src/packs.ts`, `src/generation.ts` | verify | done |
| 4 | System generation verifies | `src/generation.ts` | `verify` in `scripts/verify.sh` | done |
| 5 | Report: precision and recall against the lab ground truth, every miss listed | `docs/reports/` | `evaluate` | done |
| 5 | eShopOnAbp: Angular and .NET generations of the same commit | `systems/eshoponabp/`, `tests/eshoponabp/` | `evaluate` (local; the inputs are too large for the repository) | done |
| 6 | System generation format accepted into `devos-intelligence-contract` | proposal | contract owner | accepted 2026-10-30; waiting for the v1.2.0 tag, then vendor it and switch `systemFormat` |
| 6 | Link on `realtime.connection` (v1.2) | `src/links.ts` | lab evaluation | after the v1.2.0 tag |
| 6 | Rerun the lab evaluation on regenerated lab-core and lab-pricing (package fields) | `tests/lab` | `scripts/verify.sh`, report | waiting for the dotnet regeneration |
| 6 | OCI inputs (`oci:` in system.yml), wiki pages | | | not started |

## Gates

1. Infrastructure: image, Action, CI on both architectures.
2. Input verification and inventory with failing inputs reported.
3. Package to source with version matching, on the lab (client package consumed at the same and at an older version).
4. Cross-repository links and traces on the lab: every HTTP call of `lab-web` reaches a `lab-leasing` endpoint; every pricing client call reaches a `lab-pricing` endpoint; every Kafka message has its publisher and consumer or an unresolved reason; SignalR pushes reach the Angular subscriptions.
5. eShopOnAbp: federate the generation of `apps/angular` with the generation of the .NET services (same repository, two engines), measure precision and recall against ground truth written from source.

## Refinements (Step 0 → Step 1)

- Input names follow the lab as built (`core`, `pricing`, `intake`, `leasing`, `web`), not the Step 0 placeholders.
- `packageId` and `packageVersion` can be missing in a .NET generation: assembly-name fallback (`candidate`), version `unknown`, reported. With them present the resolution is `exact` and the version is compared.
- A package client calls through an interface: the consumer references `IPricingClient.CalculateQuoteAsync`, the `http.call` sits in `PricingClient.CalculateQuoteAsync`; implementations and bounded calls inside the producer are followed.
- Input verification separates structural errors (exclude) from dangling references (report, keep): the lab-leasing generation has a repository-scope context for project `.` with no project record, eShopOnAbp has an observation naming a package entity with no entity record.
- The Angular engine records the hub path only in `realtime.connection` (a v1.2 proposal kind) and leaves `realtime.subscribe.route` empty; the .NET engine leaves `realtime.send.method` empty when the method name is a parameter of a package helper. Real-time links are therefore `candidate` on the lab, with the reason.
- `routes` also apply to calls made through packages: the consumer configures the base address of the package's client.
- Workflow links across inputs are deferred: no generation emits `workflow.handler`.
- The wiki is left for a later step; context packs cover the agent use case.
- OCI inputs are reserved in `system.yml` and refused with a clear error; CI pulls generations and passes `--input`.
