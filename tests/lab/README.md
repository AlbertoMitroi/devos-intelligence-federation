# Lab validation inputs

`generations.tar.gz` holds the five generations of the lab system that federation is validated on, copied unchanged
(without `run.json`) from the local `_generations/` folder of the workspace on 2026-10-30. They are fixtures: CI
federates them with `../../../devos-lab/system.yml`'s content (copied in `system.yml` here) and checks the result
against `expected-links.yml`, which is written by hand from the lab ground truth.

| Input | Generation | Source commit | Engine | manifest.json sha256 (prefix) |
|---|---|---|---|---|
| core | lab-core-dotnet | devos-lab-core f7339fa11e6d | dotnet-intelligence@0.1.0 | 4b4d0ce5953e02f8 |
| pricing | lab-pricing-dotnet | devos-lab-pricing 00891c7e88ca | dotnet-intelligence@0.1.0 | d76b880bf9f4a5bf |
| intake | lab-intake-dotnet | devos-lab-intake dbc7594e8f1a | dotnet-intelligence@0.1.0 | bdac4d35aa462e94 |
| leasing | lab-leasing-dotnet | devos-lab-leasing 48d2aa0b14df | dotnet-intelligence@0.1.0 | dd5c4e0d3a56ae4e |
| web | lab-web-angular | devos-lab-web e21eef1712b2 | angular-intelligence@0.1.0 | 909509cc99744c1d |

When an engine regenerates the lab, replace the archive (`COPYFILE_DISABLE=1 tar --no-xattrs -czf ...` from
`_generations/`), update this table, rerun `scripts/verify.sh` and the report in `docs/reports/`.
