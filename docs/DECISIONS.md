# Decisions

## F1: TypeScript on Node.js 24, like angular-intelligence

- **Choice:** the federation runs its TypeScript sources with Node.js type stripping and writes `index.sqlite` with `node:sqlite`, reusing the Angular engine's canonical JSON, schema validator and index schema.
- **Reason:** one index schema for the MCP server to read; no build step; FTS5 is in Node's SQLite.

## F2: the union of the inputs is part of the system generation

- **Choice:** every input record is copied with a prefixed id (`{input}/...`), so `index.sqlite` is derived from the NDJSON files, as for engine generations.
- **Cost:** size (lab 26 MB, eShopOnAbp about 100 MB uncompressed).
- **Status:** accepted by the owner on 2026-10-30.

## F3: structural errors exclude an input, dangling references do not

- **Context:** the lab-leasing and eShopOnAbp generations pass their engines' checks but contain ids that name no record.
- **Choice:** checksum, schema, sort and capability failures exclude the input; dangling references are reported (`inputs.ndjson`, diagnostics, cards) and the input is used. The system status becomes `partial`.

## F4: assembly-name fallback for package resolution

- **Context:** the lab-core and lab-pricing generations have no `packageId`.
- **Choice:** when no project of any input declares the package id, the non-test project whose assembly name equals the package id and the package symbol's assembly is the producer, with resolution `candidate` and `versionMatch` `unknown`, both with the reason. With `packageId` present the fallback is never used.

## F5: unknown kinds are never linked

- **Choice:** contract rule 4 holds for federation too: `realtime.connection`, `ui.uses_directive`, `ui.module`, `renders` are kept in the union and reported, never used for links, even though their meaning is known from the v1.2 proposal.
- **Revisit (done 2026-10-30):** contract v1.2.0 is vendored; its kinds (`realtime.connection`, `realtime.invoke`, `call.argument`, `ui.*`, `http.interceptor`, `http.proxy`, `state.action`) and the link `renders` are known kinds, observations are validated against `schema/v1/kinds`, and real time links through `realtime.connection`. The rule still holds for kinds newer than v1.2.

## F6: test projects are not a source of cross-repository links

- **Choice:** a project whose packages include a test SDK (`Microsoft.NET.Test.Sdk`, xUnit, NUnit, MSTest) contributes no calls, publishes or package call sites to system links; the counts are in diagnostics. Simulators such as the lab's WireMock pricing double therefore never become endpoints or callers.

## F7: a message is internal when its own input consumes it

- **Choice:** a publish whose contract has a subscriber in the same input, or which the engine already linked there, is the engine's business; only publishes with no subscriber anywhere in the system become `unresolved` system links.

## F8: expectations are written from ground truth, never from output

- **Choice:** `tests/*/expected-links.yml` are transcribed from the repositories' ground truth and source before comparing; a mismatch is reported as a miss or false positive with its cause, not fixed in the expectations.

## F9: call-site values replace a template's own resolution

- **Context:** contract v1.2 (C7): a helper's observation keeps its destination null with a weak resolution and names the parameter; `call.argument` records carry the value at each call site.
- **Choice:** a site reached through such a template becomes one variant per (caller, value); the substituted value stands in for the template's missing field, so the template's own `unresolved` or `candidate` does not weaken the link. A `call.argument` without a value keeps the link `candidate` with its reason. Without any `call.argument` linking stays as in v1.1.

## F10: dispatch across inputs only where an engine cannot see it

- **Choice:** `dispatches_to` system links are emitted for a send whose handler is in another input (contract v1.2, C8, rules 1 to 6, counting every handler in the system for `ambiguous`), and `unresolved` only when the request type comes from another input and nothing handles it. Sends and handlers inside one input are the engine's links.
