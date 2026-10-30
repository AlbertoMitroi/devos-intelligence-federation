# System generation format (proposal for devos-intelligence-contract)

Status: **accepted by the owner on 2026-10-30** (layout, identity and records as written here; the union is copied).
A contract session writes it into `devos-intelligence-contract` and tags v1.2.0. Until that tag exists the federation
keeps emitting `systemFormat: 1.0-proposal` and validates with [`schema/system-proposal/`](../schema/system-proposal/)
on top of the vendored contract schemas (`schema/v1`, contract commit `ea4975a`). After the tag: vendor it, switch to
the final format name, link on `realtime.connection`.

It makes the one paragraph "System generation (federation)" of `CONTRACT-v1.1.md` concrete. Every rule is additive: a
v1.1 consumer that ignores the new files and fields still reads a system generation as a v1 generation whose ids carry a
prefix.

## Layout

| Path | Content |
|---|---|
| `manifest.json` | Written last. v1 manifest fields plus `generationType: system`, `systemFormat`, `system`, `inputs` (name, commit, manifest sha256, included) |
| `inputs.ndjson` | One record per input generation: repository, commit, dirty, engine, image digest, schema version, status, manifest sha256, `included`, verification outcome (`ok`, `ok-with-defects`, `failed` with errors, dangling references and notes). Sorted by `id` (the input name) |
| `graph/*.ndjson`, `snippets.ndjson` | The union of the included inputs' records, prefixed (see Identity), plus the system links and system diagnostics |
| `graph/packages.ndjson` | Package resolutions: one per consumer input, package and consumed version (`pkr:` ids) |
| `graph/traces.ndjson` | End-to-end traces across two or more system links (`trc:` ids) |
| `index.sqlite` | The engines' index schema over the union, plus tables `inputs`, `packages`, `traces` |
| `context/` | `overview.md`, `service-map.md` (Mermaid), `repositories/{input}.md`, `contracts/{message or method}.md`, `traces.md` |
| `run.json` | Timings and counts; excluded from determinism and not listed in the manifest |

Generated sources (`generated/`) of the inputs are not copied: an evidence record with `store: generation` points into
the input generation named by its `input` field.

## Identity

- Input name: `^[a-z0-9][a-z0-9-]*$`, unique in the system, chosen in `system.yml`.
- Every record copied from an input: `id` becomes `{input}/{id}`; every string inside the record that is a record id
  (`ev:`, `obs:`, `ctx:`, `prj:`, `snip:`, `rel:`, `decl:`, `lnk:`, `diag:` followed by 32 hex) or an entity id
  (`dotnet:`, `ts:`) gets the same prefix; free-text fields (`text`, `message`, `reason`, `signature`, `name`,
  `fullName`, `urlTemplate`, `routeTemplate`, `path`, `file`, `key`, `value`, `template`, `documentationId`) are never
  rewritten. The record gains `input`. Paths stay repository-relative.
- Validation: the v1 schemas apply with every anchored id pattern widened to `^(?:{input}/)?...`.
- System records keep unprefixed ids: system links `lnk:`, system diagnostics `diag:`, package resolutions `pkr:`,
  traces `trc:`, each over the canonical identifying fields.
- `manifest.commit` is `system:{sha256}` over the inputs' (name, commit, manifest sha256); `analysisContexts` and
  `coverage.projects` are the inputs' own, prefixed; `coverage.inputs` counts included and excluded inputs.

## System links

A system link is a `graph/links.ndjson` record with `scope: system`. It uses the v1.1 kinds: `configured_route`
(HTTP), `consumes_contract` (messaging), `pushes_to` (real time), `implemented_by_package` (package symbol to source).

| Field | Meaning |
|---|---|
| `from`, `to` | `input`, `observation` (prefixed id or null), `kind`, `project` (path inside that input), `entity` (prefixed id or null). `to` is null when `resolution` is `unresolved` |
| `from.through` | When the observation sits in a package's source and the behaviour belongs to a consumer: `package` (id, version, produced version), `packageEntity`, `sourceEntity`, `packageLink` (the `implemented_by_package` link), `observationInput`, `observationProject`, `versionMatch`. Then `from.input` and `from.entity` are the consumer's call site |
| `from.alsoObservations`, `to.alsoObservations` | Further observations of the same logical endpoint (same entity, contract and destination) |
| `match` | What matched: HTTP `method`, `route`, `endpointRoute`, `baseAddress` (key, source `observation` or `system.yml`), `targets`; messaging `contractIdentity`, `contract`, `destination`, `transports`; real time `method`, `sendMethod`, `hub` |
| `resolution`, `reason` | The weakest of the parts (call or send, endpoint or subscription, route, package, match). Any non-exact link names the parts that are not exact |
| `versionMatch`, `package` | `implemented_by_package` only |
| `evidence` | Prefixed evidence ids of both sides (at least one) |

## Package resolution record

`ecosystem` (`nuget`, `npm`), `packageId`, `version` (consumed), `consumer` (`input`, `projects` that list the
package), `producer` (`input`, `project`, `method`: `packageId`, `assemblyName` fallback or `npmName`, `packageId`,
`packageVersion`, `repository`, `commit`, `tag`: always null because generations do not record tags),
`resolution`, `versionMatch` (`exact`, `different`, `unknown`), `reason`, `entities` (`used`, `resolved`, `missing`
symbols).

## Trace record

`start`, `end` (entity or observation ids), `inputs`, `links` (system link ids, at least two), `segments` (in order:
`type: link` with the link and its sides, or `type: inside` with the step kind `call`, `implementation`,
`runtime-target`, `dispatch` or `member`, the entity reached, resolution and evidence), `resolution` (weakest),
`weakest` (`segment` index and resolution).

## Owner decisions (2026-10-30)

1. Format: accepted as written.
2. The union of the inputs is copied into the system generation.
3. `realtime.connection` and the other Angular kinds of the v1.2 proposal are accepted for v1.2; federation links on
   them once v1.2.0 is tagged and vendored.
4. Engines will record constant call-site argument values used as destinations (for example SignalR method names passed
   to a package helper); the .NET engine will also emit exact mediator links.
