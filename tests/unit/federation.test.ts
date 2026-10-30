import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { federate, loadInputs } from '../../src/federate.ts';
import { verifySystemGeneration, writeSystemGeneration, indexDump } from '../../src/generation.ts';
import { routeScore } from '../../src/links.ts';
import { parsePackageEntity, weakest } from '../../src/packages.ts';
import { readNdjson, type Rec } from '../../src/records.ts';
import { readSystem, SystemConfigError } from '../../src/system.ts';
import { prefixRecord } from '../../src/union.ts';
import { verifyInput } from '../../src/input.ts';
import { sampleSystem, tempDir } from './helpers.ts';

const seg = (r: string) => r.split('/').filter(Boolean);

test('route score: literals, parameters, catch-all, mismatch', () => {
  assert.deepEqual(routeScore(seg('/v1/orders/{}'), seg('/v1/orders/{}')), { literal: 2, guessed: 0 });
  assert.deepEqual(routeScore(seg('/v1/orders/{}'), seg('/v1/orders/search')), { literal: 2, guessed: 1 });
  assert.equal(routeScore(seg('/v1/orders'), seg('/v1/quotes')), null);
  assert.equal(routeScore(seg('/v1/orders/1/lines'), seg('/v1/orders/{}')), null);
  assert.deepEqual(routeScore(seg('/files/a/b/c'), seg('/files/{**}')), { literal: 1, guessed: 0 });
  assert.deepEqual(routeScore(seg('/v1/orders'), seg('/v1/orders/{?}')), { literal: 2, guessed: 0 });
});

test('package entity ids parse for NuGet and npm', () => {
  assert.deepEqual(parsePackageEntity('dotnet:pkg:Pricing.Client@1.0.0:Pricing.Client:M:Pricing.Client.IPricingClient.GetQuoteAsync(System.Guid)'), {
    ecosystem: 'nuget', packageId: 'Pricing.Client', version: '1.0.0', assembly: 'Pricing.Client', symbol: 'M:Pricing.Client.IPricingClient.GetQuoteAsync(System.Guid)',
  });
  assert.deepEqual(parsePackageEntity('ts:pkg:@scope/lib@2.1.0:src/index#Foo.bar'), { ecosystem: 'npm', packageId: '@scope/lib', version: '2.1.0', assembly: null, symbol: 'src/index#Foo.bar' });
  assert.equal(parsePackageEntity('dotnet:src/A/A.csproj:T:A'), null);
});

test('a link takes the weakest resolution of its parts', () => {
  assert.equal(weakest('exact', 'candidate', 'ambiguous'), 'candidate');
  assert.equal(weakest('exact', null, undefined), 'exact');
  assert.equal(weakest('ambiguous', 'exact'), 'ambiguous');
});

test('prefixing keeps free text and paths, prefixes ids and references', () => {
  const r = prefixRecord({ id: 'obs:' + 'a'.repeat(32), kind: 'http.call', caller: 'dotnet:src/A.csproj:M:A.B', evidence: ['ev:' + 'b'.repeat(32)], project: 'src/A.csproj', reason: 'dotnet:looks like an id' } as Rec, 'api');
  assert.equal(r.id, 'api/obs:' + 'a'.repeat(32));
  assert.equal(r.caller, 'api/dotnet:src/A.csproj:M:A.B');
  assert.deepEqual(r.evidence, ['api/ev:' + 'b'.repeat(32)]);
  assert.equal(r.project, 'src/A.csproj');
  assert.equal(r.reason, 'dotnet:looks like an id');
  assert.equal(r.input, 'api');
});

test('system.yml: rejects unknown route targets and duplicate names', () => {
  const dir = tempDir();
  const f = join(dir, 'system.yml');
  writeFileSync(f, 'system: s\ngenerations:\n  - { name: a, path: a }\nroutes:\n  - { from: a, baseUrl: x, to: b }\n');
  assert.throws(() => readSystem(f), SystemConfigError);
  writeFileSync(f, 'system: s\ngenerations:\n  - { name: a, path: a }\n  - { name: a, path: b }\n');
  assert.throws(() => readSystem(f), SystemConfigError);
});

test('federation links HTTP, package calls with version mismatch and Kafka; output verifies and is deterministic', () => {
  const root = tempDir();
  const { systemFile, dirs } = sampleSystem(root);
  for (const d of Object.values(dirs)) assert.deepEqual(verifyInput(d).errors, []);
  const config = readSystem(systemFile);
  const fed = federate(config, loadInputs(config));
  const http = fed.links.filter((l) => l.via === 'http');
  const web = http.find((l) => (l.from as Rec).input === 'web')!;
  assert.equal(web.resolution, 'exact');
  assert.equal((web.to as Rec).entity, 'api/dotnet:src/Api/Api.csproj:M:Api.OrdersController.Get(System.Guid)');
  const viaPackage = http.find((l) => (l.from as Rec).input === 'api')!;
  assert.equal((viaPackage.from as Rec).entity, 'api/dotnet:src/Api/Api.csproj:M:Api.Quotes.Price');
  assert.equal(((viaPackage.from as Rec).through as Rec).versionMatch, 'different');
  assert.equal((viaPackage.to as Rec).entity, 'pricing/dotnet:src/Pricing.Api/Pricing.Api.csproj:M:Pricing.Api.QuotesController.Create');
  assert.equal(viaPackage.resolution, 'exact');
  const pkg = fed.packages.find((p) => p.packageId === 'Pricing.Client')!;
  assert.equal(pkg.versionMatch, 'different');
  assert.equal((pkg.producer as Rec).packageVersion, '1.1.0');
  const kafka = fed.links.find((l) => l.via === 'messaging')!;
  assert.equal(kafka.resolution, 'exact');
  assert.equal((kafka.to as Rec).input, 'worker');

  const out1 = join(root, 'out1');
  const out2 = join(root, 'out2');
  writeSystemGeneration(fed, out1, 0);
  writeSystemGeneration(federate(config, loadInputs(config)), out2, 0);
  const v = verifySystemGeneration(out1, new Map(Object.entries(dirs)));
  assert.deepEqual(v.errors, []);
  for (const f of ['manifest.json', 'graph/links.ndjson', 'graph/entities.ndjson', 'inputs.ndjson', 'graph/packages.ndjson', 'context/overview.md'])
    assert.equal(readFileSync(join(out1, f), 'utf8'), readFileSync(join(out2, f), 'utf8'), f);
  assert.equal(indexDump(out1), indexDump(out2));
  assert.ok(readNdjson(join(out1, 'inputs.ndjson')).every((i) => i.included === true));
});

test('a tampered input is excluded and reported; a tampered system generation fails verify', () => {
  const root = tempDir();
  const { systemFile, dirs } = sampleSystem(root);
  writeFileSync(join(dirs.worker, 'graph/observations.ndjson'), '');
  const config = readSystem(systemFile);
  const states = loadInputs(config);
  const worker = states.find((s) => s.name === 'worker')!;
  assert.equal(worker.input, null);
  assert.match(worker.verification.errors.join('\n'), /checksum mismatch/);
  const fed = federate(config, states);
  const unresolved = fed.links.find((l) => l.via === 'messaging')!;
  assert.equal(unresolved.resolution, 'unresolved');
  assert.match(unresolved.reason as string, /no subscriber in the system/);
  const out = join(root, 'out');
  const result = writeSystemGeneration(fed, out, 0);
  assert.equal(result.status, 'partial');
  assert.ok(readNdjson(join(out, 'graph/diagnostics.ndjson')).some((d) => d.code === 'input-excluded'));
  assert.deepEqual(verifySystemGeneration(out).errors, []);
  writeFileSync(join(out, 'graph/links.ndjson'), readFileSync(join(out, 'graph/links.ndjson'), 'utf8').replace('"exact"', '"candidate"'));
  assert.match(verifySystemGeneration(out).errors.join('\n'), /checksum mismatch/);
});
