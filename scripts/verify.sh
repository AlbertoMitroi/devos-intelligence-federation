#!/usr/bin/env bash
# The single local verify command. Needs only Docker.
# 1. builds the test stage (type check, unit tests),
# 2. builds the runtime and action images and checks their self-description (Node, SQLite FTS5, non-root user),
# 3. federates the lab generations (tests/lab) twice with the runtime image, read-only inputs, and compares the two
#    system generations byte for byte (run.json excluded) and through the canonical dump of index.sqlite,
# 4. verifies the system generation (with the inputs' manifest digests) and evaluates it against
#    tests/lab/expected-links.yml: recall must be 1.000 and every expected unresolved link present,
# 5. runs the action image in GitHub Action mode against a simulated workspace.
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
tag="${FED_VERIFY_TAG:-intelligence-federation:verify}"
work="$root/.verify"
user="$(id -u):$(id -g)"

step() { printf '\n== %s\n' "$*"; }

rm -rf "$work"
mkdir -p "$work/inputs" "$work/out" "$work/workspace"

step "test stage"
docker build --target test -t "$tag-test" "$root"

step "runtime and action images"
docker build --target runtime -t "$tag" "$root"
docker build --target action -t "$tag-action" "$root"

step "self-test"
docker run --rm --network none "$tag" version --json | tee "$work/version.json"
grep -q '"fts5":true' "$work/version.json"
[ "$(docker run --rm --entrypoint id "$tag" -u)" != "0" ]

step "lab inputs"
tar -xzf "$root/tests/lab/generations.tar.gz" -C "$work/inputs"

inputs=(--input core=/generations/lab-core-dotnet --input pricing=/generations/lab-pricing-dotnet
        --input intake=/generations/lab-intake-dotnet --input leasing=/generations/lab-leasing-dotnet
        --input web=/generations/lab-web-angular)

step "federate the lab twice"
for run in 1 2; do
  docker run --rm --network none --user "$user" \
    -v "$work/inputs:/generations:ro" -v "$root/tests/lab:/config:ro" -v "$work/out:/out" \
    "$tag" federate --system /config/system.yml --out "/out/lab-$run" "${inputs[@]}"
done
diff -r -x run.json "$work/out/lab-1" "$work/out/lab-2"
docker run --rm --network none -v "$work/out:/out:ro" "$tag" dump-index /out/lab-1 > "$work/dump-1.txt"
docker run --rm --network none -v "$work/out:/out:ro" "$tag" dump-index /out/lab-2 > "$work/dump-2.txt"
cmp "$work/dump-1.txt" "$work/dump-2.txt"
echo "two runs are byte-identical (run.json excluded) and their index dumps are identical"

step "verify and evaluate"
docker run --rm --network none -v "$work/inputs:/generations:ro" -v "$work/out:/out:ro" \
  "$tag" verify /out/lab-1 "${inputs[@]}"
docker run --rm --network none --user "$user" -v "$work/out:/out" -v "$root/tests/lab:/config:ro" \
  "$tag" evaluate /out/lab-1 --expected /config/expected-links.yml --report /out/lab-evaluation.md --json /out/lab-evaluation.json \
  | tee "$work/evaluation.txt"
grep -q 'recall 1.000' "$work/evaluation.txt"
node_check='const e=JSON.parse(require("fs").readFileSync(0,"utf8"));const bad=e.unresolved.filter(u=>!u.found).map(u=>u.id);if(bad.length){console.error("missing unresolved: "+bad);process.exit(1)}'
docker run --rm -i --entrypoint node "$tag" -e "$node_check" < "$work/out/lab-evaluation.json"

step "action mode"
mkdir -p "$work/workspace/generations"
cp -R "$work/inputs/." "$work/workspace/generations/"
cp "$root/tests/lab/system.yml" "$work/workspace/system.yml"
docker run --rm --network none -v "$work/workspace:/github/workspace" \
  -e GITHUB_WORKSPACE=/github/workspace -e GITHUB_OUTPUT=/github/workspace/outputs.txt \
  -e INPUT_SYSTEM=system.yml -e INPUT_OUTPUT=system-out \
  -e "INPUT_INPUTS=$(printf 'core=generations/lab-core-dotnet\npricing=generations/lab-pricing-dotnet\nintake=generations/lab-intake-dotnet\nleasing=generations/lab-leasing-dotnet\nweb=generations/lab-web-angular')" \
  "$tag-action" gha
cat "$work/workspace/outputs.txt"
grep -q '^manifest-path=system-out/manifest.json$' "$work/workspace/outputs.txt"
[ "$(stat -c %u "$work/workspace/system-out/manifest.json" 2>/dev/null || stat -f %u "$work/workspace/system-out/manifest.json")" = "$(id -u)" ]

step "ok"
