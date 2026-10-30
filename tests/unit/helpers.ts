// Builds small, valid generations on disk for the unit tests (contract v1.1 layout, manifest with checksums).
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { canonical, compareOrdinal, recordId } from '../../src/util/canonical.ts';
import { FILES, type Rec, type RecordSet } from '../../src/records.ts';

export function tempDir(prefix = 'fed-test-'): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

export interface GenSpec {
  remoteUrl: string;
  engine?: string;
  projects: { path: string; extra?: Record<string, unknown> }[];
  entities?: { id: string; project: string; name?: string }[];
  relations?: { from: string; to: string; kind: string; usage?: string; project: string }[];
  observations?: (Record<string, unknown> & { kind: string; project: string })[];
}

/** Writes a generation and returns its directory. Every observation and relation gets one evidence record. */
export function writeGeneration(dir: string, spec: GenSpec): string {
  mkdirSync(dir, { recursive: true });
  const set: RecordSet = { projects: [], entities: [], declarations: [], relations: [], evidence: [], observations: [], links: [], diagnostics: [], snippets: [] };
  const ctxOf = new Map<string, string>();
  for (const p of spec.projects) {
    const prj = recordId('prj', { path: p.path });
    const ctx = recordId('ctx', { project: p.path });
    ctxOf.set(p.path, ctx);
    set.projects.push({ id: prj, recordType: 'project', path: p.path, assemblyName: p.path.split('/').pop()!.replace(/\.csproj$/, ''), packages: [], projectReferences: [], solutions: [], targetFrameworks: ['net8.0'], ...(p.extra ?? {}) });
    set.projects.push({ id: ctx, recordType: 'analysisContext', project: p.path, projectId: prj, loadMode: 'semantic', reason: 'loaded', configuration: 'Debug', targetFramework: 'net8.0', preprocessorSymbols: [] });
  }
  let line = 1;
  const evidence = (project: string): string => {
    const ev = recordId('ev', { project, line });
    set.evidence.push({ id: ev, path: `${project}/File.cs`, blobId: '0'.repeat(40), span: { startLine: line, startColumn: 1, endLine: line, endColumn: 2 }, method: 'semantic', context: ctxOf.get(project)!, extractor: 'test@0.0.0', store: 'repository' });
    line++;
    return ev;
  };
  for (const e of spec.entities ?? []) set.entities.push({ id: e.id, kind: 'method', name: e.name ?? e.id.split('.').pop()!, signature: e.id, accessibility: 'public', modifiers: [], origin: e.id.includes(':pkg:') ? 'metadata' : 'source', container: null, project: e.id.includes(':pkg:') ? undefined : e.project });
  for (const r of spec.relations ?? []) set.relations.push({ id: recordId('rel', r), kind: r.kind, from: r.from, to: r.to, ...(r.usage ? { usage: r.usage } : {}), resolution: 'exact', context: ctxOf.get(r.project)!, evidence: [evidence(r.project)] });
  for (const o of spec.observations ?? []) set.observations.push({ id: recordId('obs', o), context: ctxOf.get(o.project)!, evidence: [evidence(o.project)], ...o });
  for (const key of Object.keys(set) as (keyof RecordSet)[]) {
    set[key].sort((a, b) => compareOrdinal(a.id, b.id));
    const file = join(dir, FILES[key]);
    mkdirSync(join(file, '..'), { recursive: true });
    writeFileSync(file, set[key].map((r: Rec) => canonical(r) + '\n').join(''));
  }
  const files = walk(dir).map((p) => {
    const bytes = readFileSync(join(dir, p));
    return { path: p, sha256: createHash('sha256').update(bytes).digest('hex'), size: bytes.length };
  });
  const manifest = {
    schemaVersion: '1.1',
    requiredCapabilities: [],
    status: 'complete',
    engine: { name: spec.engine ?? 'dotnet-intelligence', version: '0.1.0' },
    imageDigest: 'unknown',
    repository: { remoteUrl: spec.remoteUrl },
    commit: createHash('sha1').update(spec.remoteUrl).digest('hex'),
    dirty: false,
    configurationHash: null,
    analysisContexts: [...ctxOf.values()].sort(compareOrdinal),
    coverage: { projects: spec.projects.map((p) => ({ path: p.path, state: 'semantic' })), summary: { total: spec.projects.length, semantic: spec.projects.length, syntax: 0, failed: 0, notAnalyzed: 0 } },
    files,
  };
  writeFileSync(join(dir, 'manifest.json'), canonical(manifest) + '\n');
  return dir;
}

function walk(dir: string, root = dir): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir).sort()) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...walk(full, root));
    else out.push(relative(root, full));
  }
  return out.filter((p) => p !== 'manifest.json').sort(compareOrdinal);
}

/**
 * A three-repository system: `web` calls `api` over HTTP (base address key `environment.apiUrl`), `api` calls
 * `pricing` through the package `Pricing.Client` (produced by `pricing`, consumed at an older version), and `api`
 * publishes a Kafka record consumed by `worker`.
 */
export function sampleSystem(root: string): { systemFile: string; dirs: Record<string, string> } {
  const web = writeGeneration(join(root, 'web'), {
    remoteUrl: 'https://example.test/web.git',
    engine: 'angular-intelligence',
    projects: [{ path: '.', extra: { language: 'typescript' } }],
    entities: [{ id: 'ts:.:src/orders.service#OrdersService.list', project: '.' }],
    observations: [
      { kind: 'http.call', project: '.', method: 'GET', canonicalRoute: '/v1/orders/{}', caller: 'ts:.:src/orders.service#OrdersService.list', resolution: 'exact', baseAddress: { key: 'environment.apiUrl', nameSource: 'configuration', values: [{ value: 'https://api.example.test' }] } },
    ],
  });
  const P = 'src/Api/Api.csproj';
  const api = writeGeneration(join(root, 'api'), {
    remoteUrl: 'https://example.test/api.git',
    projects: [{ path: P, extra: { packages: [{ id: 'Pricing.Client', version: '1.0.0', direct: true }] } }],
    entities: [
      { id: `dotnet:${P}:M:Api.OrdersController.Get(System.Guid)`, project: P },
      { id: `dotnet:${P}:M:Api.Quotes.Price`, project: P },
      { id: 'dotnet:pkg:Pricing.Client@1.0.0:Pricing.Client:M:Pricing.Client.IPricingClient.Quote', project: P },
      { id: `dotnet:${P}:M:Api.Orders.Publish`, project: P },
    ],
    relations: [{ from: `dotnet:${P}:M:Api.Quotes.Price`, to: 'dotnet:pkg:Pricing.Client@1.0.0:Pricing.Client:M:Pricing.Client.IPricingClient.Quote', kind: 'calls_declared_target', project: P }],
    observations: [
      { kind: 'http.endpoint', project: P, method: 'GET', canonicalRoute: '/v1/orders/{}', handler: `dotnet:${P}:M:Api.OrdersController.Get(System.Guid)`, resolution: 'exact' },
      { kind: 'messaging.publish', project: P, publisher: `dotnet:${P}:M:Api.Orders.Publish`, contract: { fullName: 'Shop.OrderPlaced' }, transport: 'kafka', destination: { kind: 'topic', name: 'orders-v1', nameSource: 'configuration' }, resolution: 'exact' },
      { kind: 'config.key', project: P, key: 'Clients:Pricing:BaseAddress', file: 'appsettings.json', secret: false },
    ],
  });
  const C = 'src/Pricing.Client/Pricing.Client.csproj';
  const A = 'src/Pricing.Api/Pricing.Api.csproj';
  const pricing = writeGeneration(join(root, 'pricing'), {
    remoteUrl: 'https://example.test/pricing.git',
    projects: [{ path: C, extra: { packageId: 'Pricing.Client', packageVersion: '1.1.0', isPackable: true } }, { path: A }],
    entities: [
      { id: `dotnet:${C}:M:Pricing.Client.IPricingClient.Quote`, project: C },
      { id: `dotnet:${C}:M:Pricing.Client.PricingClient.Quote`, project: C },
      { id: `dotnet:${A}:M:Pricing.Api.QuotesController.Create`, project: A },
    ],
    relations: [{ from: `dotnet:${C}:M:Pricing.Client.PricingClient.Quote`, to: `dotnet:${C}:M:Pricing.Client.IPricingClient.Quote`, kind: 'implements', project: C }],
    observations: [
      { kind: 'http.call', project: C, method: 'POST', canonicalRoute: '/api/quotes', caller: `dotnet:${C}:M:Pricing.Client.PricingClient.Quote`, resolution: 'exact' },
      { kind: 'http.endpoint', project: A, method: 'POST', canonicalRoute: '/api/quotes', handler: `dotnet:${A}:M:Pricing.Api.QuotesController.Create`, resolution: 'exact' },
    ],
  });
  const W = 'src/Worker/Worker.csproj';
  const worker = writeGeneration(join(root, 'worker'), {
    remoteUrl: 'https://example.test/worker.git',
    projects: [{ path: W }],
    entities: [{ id: `dotnet:${W}:T:Worker.OrderPlacedConsumer`, project: W }],
    observations: [{ kind: 'messaging.subscribe', project: W, handler: `dotnet:${W}:T:Worker.OrderPlacedConsumer`, contract: { fullName: 'Shop.OrderPlaced' }, transport: 'kafka', destination: { kind: 'topic', name: 'orders-v1', nameSource: 'configuration' }, resolution: 'exact' }],
  });
  const systemFile = join(root, 'system.yml');
  writeFileSync(
    systemFile,
    [
      'system: sample',
      'generations:',
      '  - { name: web, path: web }',
      '  - { name: api, path: api }',
      '  - { name: pricing, path: pricing }',
      '  - { name: worker, path: worker }',
      'routes:',
      '  - { from: web, baseUrl: environment.apiUrl, to: api }',
      '  - { from: api, baseUrl: "Clients:Pricing:BaseAddress", to: pricing }',
      'messaging:',
      '  contractIdentity: typeName',
      '',
    ].join('\n'),
  );
  return { systemFile, dirs: { web, api, pricing, worker } };
}
