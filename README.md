# intelligence-federation

Combines generations of several repositories (from `dotnet-intelligence` and `angular-intelligence`, contract in
`../devos-intelligence-contract`) into one verifiable **system generation**: package-to-source resolution, links across
repositories (HTTP, messaging, real time, through client packages), end-to-end traces, `index.sqlite` over the union and
system context packs, manifest written last.

**Status: Step 1 done** (lab and eShopOnAbp validated, see [docs/reports/step-1-lab-and-eshoponabp.md](docs/reports/step-1-lab-and-eshoponabp.md)).
Plan: [docs/PLAN.md](docs/PLAN.md). Output format (proposal to the contract owner): [docs/SYSTEM-GENERATION.md](docs/SYSTEM-GENERATION.md).
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
| `gha` | GitHub Action mode (`action.yml`) |

`scripts/verify.sh` is the full local check (test stage, images, the lab twice, verify, evaluate, Action mode).

## License

MIT, see [LICENSE](LICENSE).
