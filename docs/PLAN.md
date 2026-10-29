# intelligence-federation: plan (Step 0)

## Why a separate product

Each engine analyses one repository (the dotnet prompt puts cross-repository linking out of its scope). A real system spans repositories: an Angular front end, a backend that consumes another team's API through a client NuGet package, and services that talk over Kafka and RabbitMQ. Federation works only on generations, never on source, so it is technology-neutral and runs anywhere the generations are.

Rules from the dotnet prompt that carry over: Docker-first, CI-native (Action + `docker run`), artifacts only, determinism (same inputs and configuration give byte-identical output), evidence on every link, unknown is not empty, no invented results, no built-in knowledge of any repository.

## Inputs

`system.yml`, supplied by the caller:

```yaml
system: lab
generations:
  - name: web
    path: generations/lab-web          # or oci: ghcr.io/org/context-web@sha256:...
  - name: lifecycle
    path: generations/lab-lifecycle
  - name: rating
    path: generations/lab-rating
routes:                                  # how a caller reaches a service, when not derivable
  - from: web
    baseUrl: environment.apiUrl          # value or configuration key seen in the caller's generation
    to: lifecycle
messaging:
  contractIdentity: typeName             # or entity, or destination
```

## Pipeline

1. **Verify inputs**: each generation passes `verify` (contract rules: major 1, known required capabilities, checksums, integrity). A failed input is reported and excluded; the system generation records it.
2. **Inventory** (`inputs.ndjson`): repository, commit, dirty flag, engine and version, image digest, schema version, manifest sha256.
3. **Package to source**: for every `dotnet:pkg:{id}@{version}:...` entity used by one input, find the input whose project has `packageId == id` (contract v1.1) and the same documentation id; emit `implemented_by_package` with `versionMatch` (`exact` when the producing project's version equals the consumed version at that commit, `different` with both versions, `unknown`). Same for `ts:pkg:` and `npmName`.
4. **Cross-repository links**, from normalized fields only:
   - HTTP: `http.call` (Angular or .NET, including calls inside a resolved client package) to `http.endpoint` of the target input, via base address (configuration, environment files, `routes` in `system.yml`), canonical routes and route precedence; a call made through a package method is attributed to the consumer's call site.
   - Messaging: publish to subscribe across inputs by contract identity, transport and destination (topic, queue, exchange); Kafka topics without a subscriber inside the system are kept as `unresolved` with the reason (the consumer may be outside the system).
   - Real time: `realtime.send` to Angular `realtime.subscribe` by hub route and method name.
   - Workflow: `workflow.node` to `workflow.handler` across inputs when the handler lives in another repository (for example shared plugin packages).
5. **Traces**: bounded paths across links and in-repository relations, each segment with its resolution and evidence, weakest link reported (for example: Angular component event binding → service method → `http.call` → Lifecycle endpoint → MediatR handler → package method of the rating client → resolved client source → `http.call` → rating API endpoint → EF Core table).
6. **Artifacts**: system manifest (written last), `graph/links.ndjson` across inputs, `inputs.ndjson`, diagnostics, `index.sqlite` over the union, system context packs (system overview, service map with Mermaid, one card per repository and per contract), wiki.

## Identity

Records keep their input's ids, prefixed with the input name (`lifecycle/rel:...`); entity ids are already globally unique (`dotnet:{project}:{docId}` within a repository, made unique across repositories by the input prefix). A system link has its own id over the canonical identifying fields.

## Gates

1. Infrastructure: image, Action, CI on both architectures.
2. Input verification and inventory with failing inputs reported.
3. Package to source with version matching, on the lab (client package consumed at the same and at an older version).
4. Cross-repository links and traces on the lab: every HTTP call of `lab-web` reaches a `lab-lifecycle` endpoint; every rating client call reaches a `lab-rating` endpoint; every Kafka and RabbitMQ message has its publisher and consumer or an unresolved reason.
5. eShopOnAbp: federate the generation of `apps/angular` with the generation of the .NET services (same repository, two engines), measure precision and recall against ground truth written from source.
