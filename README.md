# intelligence-federation

Combines generations of several repositories (from `dotnet-intelligence` and `angular-intelligence`, contract in
`../devos-intelligence-contract`) into one verifiable **system generation**: package-to-source resolution, links across
repositories (HTTP, messaging, real time, through client packages), end-to-end traces, `index.sqlite` over the union and
system context packs, manifest written last.

**Status: Step 1 done** on contract v1.2: lab precision and recall 1.000 on v1.2 generations ([docs/reports/step-1b-lab-contract-v1.2.md](docs/reports/step-1b-lab-contract-v1.2.md); Step 1 on v1.1 inputs: [docs/reports/step-1-lab-and-eshoponabp.md](docs/reports/step-1-lab-and-eshoponabp.md)).
Plan: [docs/PLAN.md](docs/PLAN.md). Output format: contract v1.2 (`devos-intelligence-contract` tag `v1.2.0`, section "System generation"), vendored in `schema/`; design notes in [docs/SYSTEM-GENERATION.md](docs/SYSTEM-GENERATION.md).
Decisions: [docs/DECISIONS.md](docs/DECISIONS.md).

## Run

Docker (only requirement):

```bash
docker build --target runtime -t intelligence-federation .
docker run --rm -v "$PWD/generations:/generations:ro" -v "$PWD/system.yml:/config/system.yml:ro" -v "$PWD/out:/out" \
  intelligence-federation federate --system /config/system.yml --out /out/system \
  --input web=/generations/web --input leasing=/generations/leasing
docker run --rm -v "$PWD/out:/out:ro" intelligence-federation verify /out/system
```

Local (Node.js 24 or later): `npm ci`, then `node src/cli.ts <command>`.

| Command | Does |
|---|---|
| `federate --system <system.yml> --out <dir> [--input name=dir]...` | Verifies the inputs, links them, writes the system generation |
| `verify <dir> [--input name=dir]...` | Checksums, schemas, references; with `--input`, the inputs' manifest digests |
| `evaluate <dir> --expected <expected-links.yml> [--report md] [--json file]` | Precision and recall against hand-written expectations |
| `dump-index <dir>` | Canonical dump of `index.sqlite` (what determinism compares) |
| `list-inputs --system <system.yml>` | The generations of a system with their OCI references (for a publisher that pulls them) |
| `gha` | GitHub Action mode (`action.yml`) |

Images, Action and the OCI layout of a published system generation: [docs/PUBLISHING.md](docs/PUBLISHING.md).

`scripts/verify.sh` is the full local check (test stage, images, the lab twice, verify, evaluate, Action mode).

## License

MIT, see [LICENSE](LICENSE).
