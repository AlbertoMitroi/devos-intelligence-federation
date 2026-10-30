# Publishing

## The federation image (release)

`.github/workflows/release.yml`, the engines' pattern: a tag `v<version>` on a commit where `package.json` and
`action.yml` carry that version builds the test stage and the `runtime` and `action` targets on amd64 and arm64
(provenance and SBOM), pushes them by digest, joins them into multi-architecture tags and creates the GitHub release
with the vendored contract schema. A manual run builds without pushing (dry run).

| Image | Use |
|---|---|
| `ghcr.io/albertomitroi/intelligence-federation:<version>` | `docker run` (`federate`, `verify`, `evaluate`, `list-inputs`, `dump-index`) |
| `ghcr.io/albertomitroi/intelligence-federation:<version>-action` | the GitHub Action (`action.yml`); the tag `v1` moves with every 0.x release |

## A system generation as an OCI artifact

A system generation is published with the same layout as an engine's generation (devos-dotnet-intelligence
`docs/USAGE.md`, "Publishing the generation (OCI)"), so one consumer reads both. The lab's publisher is
`devos-lab/scripts/system-context.sh`, run by `devos-lab/.github/workflows/system-context.yml`.

| Part | Value |
|---|---|
| Inputs | each generation in `system.yml` with `oci: <reference>`, resolved to its digest before pulling; the pulled layer is checked against its `dev.devos.intelligence.manifest-sha256` annotation; passed to `federate` with `--input` |
| Checks before publishing | `verify` with every input (manifest digests re-checked); no input may be excluded; status not `failed` |
| Reference | `ghcr.io/<owner>/context-<system repository>:system-<key>` plus the moving tag `main-system`; lowercase |
| `<key>` | SHA-256 of `manifest.commit` (`system:` over every input's name, commit and manifest digest), `manifest.configurationHash` (system.yml) and `name@version` of the federation, joined by newlines. The same key means the same inputs, configuration and federation; the script refuses to overwrite an existing `system-<key>` whose `manifest.json` differs and only moves `main-system` when it is the same |
| Manifest `artifactType` | `application/vnd.devos.intelligence.generation.v1` |
| Layer | `generation.tar.gz`, media type `application/vnd.devos.intelligence.generation.v1.tar+gzip`; tar root is the system generation directory; entries sorted, mtime 0, owner and group 0, gzip without timestamp. Two runs differ only in `run.json`, which is outside the determinism contract |
| Layer annotation | `dev.devos.intelligence.manifest-sha256` |
| Manifest annotations | `org.opencontainers.image.source` and `.revision` (the system repository and its commit, the one that holds system.yml), `org.opencontainers.image.ref.name`, `dev.devos.intelligence.engine` (`intelligence-federation`), `dev.devos.intelligence.system-commit` (`manifest.commit`), `dev.devos.intelligence.inputs` (`name=reference@digest` for every input, space separated), `dev.devos.intelligence.federation-image` (image digest); ORAS adds `org.opencontainers.image.created` |

A consumer (the MCP server) pulls `main-system` or a pinned `system-<key>`, checks the layer against
`dev.devos.intelligence.manifest-sha256`, unpacks it and runs `verify`; `index.sqlite` follows the contract's index
schema 1.

## When it runs (lab)

- `repository_dispatch` `context-published`: the last step of each lab repository's `context` workflow, after it pushed
  its generation. It needs the secret `DEVOS_LAB_DISPATCH_TOKEN` in that repository (a fine-grained token with
  Contents read and write on `devos-lab`); without it the step is skipped.
- `workflow_dispatch`: after a change to `system.yml`, or to publish by hand; `push: false` writes an OCI layout and
  uploads it as a workflow artifact instead of pushing.
- Runs are serialized; each reads the moving `main-*` tags, so the newest pending run covers the ones it replaced.
