# Decisions

## F1: TypeScript on Node.js 24, like angular-intelligence

- **Choice:** the federation runs its TypeScript sources with Node.js type stripping and writes `index.sqlite` with `node:sqlite`, reusing the Angular engine's canonical JSON, schema validator and index schema.
- **Reason:** one index schema for the MCP server to read; no build step; FTS5 is in Node's SQLite.

## F2: the union of the inputs is part of the system generation

- **Choice:** every input record is copied with a prefixed id (`{input}/...`), so `index.sqlite` is derived from the NDJSON files, as for engine generations.
- **Cost:** size (lab 26 MB, eShopOnAbp about 100 MB uncompressed). Open question 2 of the format proposal.

## F3: structural errors exclude an input, dangling references do not

- **Context:** the lab-leasing and eShopOnAbp generations pass their engines' checks but contain ids that name no record.
- **Choice:** checksum, schema, sort and capability failures exclude the input; dangling references are reported (`inputs.ndjson`, diagnostics, cards) and the input is used. The system status becomes `partial`.

## F4: assembly-name fallback for package resolution

- **Context:** the lab-core and lab-pricing generations have no `packageId`.
- **Choice:** when no project of any input declares the package id, the non-test project whose assembly name equals the package id and the package symbol's assembly is the producer, with resolution `candidate` and `versionMatch` `unknown`, both with the reason. With `packageId` present the fallback is never used.

## F5: unknown kinds are never linked

- **Choice:** contract rule 4 holds for federation too: `realtime.connection`, `ui.uses_directive`, `ui.module`, `renders` are kept in the union and reported, never used for links, even though their meaning is known from the v1.2 proposal.

## F6: test projects are not a source of cross-repository links

- **Choice:** a project whose packages include a test SDK (`Microsoft.NET.Test.Sdk`, xUnit, NUnit, MSTest) contributes no calls, publishes or package call sites to system links; the counts are in diagnostics. Simulators such as the lab's WireMock pricing double therefore never become endpoints or callers.

## F7: a message is internal when its own input consumes it

- **Choice:** a publish whose contract has a subscriber in the same input, or which the engine already linked there, is the engine's business; only publishes with no subscriber anywhere in the system become `unresolved` system links.

## F8: expectations are written from ground truth, never from output

- **Choice:** `tests/*/expected-links.yml` are transcribed from the repositories' ground truth and source before comparing; a mismatch is reported as a miss or false positive with its cause, not fixed in the expectations.
