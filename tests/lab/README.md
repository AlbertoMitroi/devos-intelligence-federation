# Lab validation inputs

`generations.tar.gz` holds the five generations of the lab system that federation is validated on, copied unchanged
(without `run.json`) from the local `_generations/` folder of the workspace on 2026-10-30 at 11:40, after the
regeneration with the contract v1.2 engines (dotnet-intelligence main 78121ab, angular-intelligence main a7d8cdf).
They are fixtures: CI federates them with `system.yml` (a copy of `devos-lab/system.yml`) and checks the result against
`expected-links.yml`, which is written by hand from the lab ground truth.

| Input | Generation | Source commit | Engine | Schema | manifest.json sha256 (prefix) |
|---|---|---|---|---|---|
| core | lab-core-dotnet | devos-lab-core cdc080f36a28 | dotnet-intelligence@0.1.0 | 1.2 | 2f024edd7dcbea19 |
| pricing | lab-pricing-dotnet | devos-lab-pricing 0ee03cc9eb17 | dotnet-intelligence@0.1.0 | 1.2 | a766b57c7e6ce880 |
| intake | lab-intake-dotnet | devos-lab-intake 1e3322fa4e2d | dotnet-intelligence@0.1.0 | 1.2 | 086f243423e8f491 |
| leasing | lab-leasing-dotnet | devos-lab-leasing c2dbb16a3b95 | dotnet-intelligence@0.1.0 | 1.2 | 3e87f222b4ed7d51 |
| web | lab-web-angular | devos-lab-web 66264d596794 | angular-intelligence@0.1.0 | 1.2 | 0a7b23749f78d7d1 |

The source commits are the lab repositories' `main` after the MIT license commit; the ground truth items used by
`expected-links.yml` are unchanged by it.

When an engine regenerates the lab, replace the archive (`COPYFILE_DISABLE=1 tar --no-xattrs -czf ...` from
`_generations/`), update this table, rerun `scripts/verify.sh` and the report in `docs/reports/`.
