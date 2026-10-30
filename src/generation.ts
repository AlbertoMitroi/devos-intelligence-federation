// Writing and verifying a system generation (proposal: docs/SYSTEM-GENERATION.md). manifest.json is written last;
// run.json after it, outside the determinism contract.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { canonical, compareOrdinal, recordId, sha256Hex } from './util/canonical.ts';
import { validate } from './artifacts/schema.ts';
import { checkIntegrity, schemaFor } from './integrity.ts';
import type { Federation, InputState } from './federate.ts';
import { readNdjson, readRecords, SYSTEM_FILES, writeNdjson, FILES, type Rec, type RecordSet } from './records.ts';
import { buildPacks } from './packs.ts';
import { dumpIndex, writeIndex } from './sqlite.ts';
import { union } from './union.ts';

export const ENGINE = { name: 'intelligence-federation', version: '0.1.0' };
export const SCHEMA_VERSION = '1.1';
export const SYSTEM_FORMAT = '1.0-proposal';

export function inputRecord(s: InputState): Rec {
  const m = s.input?.manifest;
  const v = s.verification;
  return {
    id: s.name,
    recordType: 'input',
    source: s.path ? 'path' : 'oci',
    oci: s.oci,
    repository: m ? { remoteUrl: m.repository?.remoteUrl ?? null } : null,
    commit: m?.commit ?? null,
    dirty: m?.dirty ?? null,
    engine: m?.engine ?? null,
    imageDigest: m?.imageDigest ?? null,
    schemaVersion: m?.schemaVersion ?? null,
    status: m?.status ?? null,
    manifestSha256: s.input?.manifestSha256 ?? null,
    included: !!s.input,
    verification: {
      result: !v.ok ? 'failed' : v.references.length ? 'ok-with-defects' : 'ok',
      errors: v.errors,
      references: v.references,
      notes: v.notes,
    },
  };
}

function diagnostic(code: string, scope: string, severity: 'info' | 'warning' | 'error', state: string, message: string): Rec {
  return { id: recordId('diag', { code, scope, message }), code, scope, severity, state, message };
}

export function systemDiagnostics(fed: Federation): Rec[] {
  const out: Rec[] = [];
  for (const s of fed.states) {
    if (!s.input) out.push(diagnostic('input-excluded', s.name, 'error', 'failed', `Input ${s.name} failed verification and is excluded: ${s.verification.errors.slice(0, 5).join('; ')}`));
    else if (s.verification.references.length) out.push(diagnostic('input-dangling-references', s.name, 'warning', 'partial', `Input ${s.name} has ${s.verification.references.length >= 50 ? '50 or more' : s.verification.references.length} dangling references (kept; links that need them may be missing): ${s.verification.references.slice(0, 3).join('; ')}`));
    for (const n of s.verification.notes) if (n.startsWith('kind not in contract')) out.push(diagnostic('input-unknown-kind', s.name, 'info', 'unsupported', `${s.name}: ${n}`));
  }
  for (const n of fed.notes) out.push(diagnostic(n.code, n.scope, 'info', n.state, n.message));
  const unresolved = fed.links.filter((l) => l.resolution === 'unresolved').length;
  if (unresolved) out.push(diagnostic('unresolved-system-links', 'system', 'info', 'partial', `${unresolved} of ${fed.links.length} cross-repository links are unresolved; each has its reason in graph/links.ndjson.`));
  const dedup = new Map(out.map((d) => [d.id, d]));
  return [...dedup.values()].sort((a, b) => compareOrdinal(a.id, b.id));
}

function walk(dir: string, root = dir): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...walk(full, root));
    else out.push(relative(root, full).split('\\').join('/'));
  }
  return out;
}

function fileList(dir: string): { path: string; sha256: string; size: number }[] {
  return walk(dir)
    .filter((p) => p !== 'manifest.json' && p !== 'run.json')
    .sort(compareOrdinal)
    .map((p) => {
      const bytes = readFileSync(join(dir, p));
      return { path: p, sha256: createHash('sha256').update(bytes).digest('hex'), size: bytes.length };
    });
}

export interface WriteResult {
  status: 'complete' | 'partial' | 'failed';
  counts: Record<string, number>;
}

export function writeSystemGeneration(fed: Federation, out: string, startedAt: number): WriteResult {
  if (existsSync(out) && readdirSync(out).length) throw new Error(`output directory ${out} must be absent or empty`);
  mkdirSync(out, { recursive: true });
  const inputs = fed.states.map(inputRecord).sort((a, b) => compareOrdinal(a.id, b.id));
  const set: RecordSet = union(fed.inputs);
  set.links = [...set.links, ...fed.links, ...fed.packageLinks].sort((a, b) => compareOrdinal(a.id, b.id));
  set.diagnostics = [...set.diagnostics, ...systemDiagnostics(fed)].sort((a, b) => compareOrdinal(a.id, b.id));
  for (const [key, file] of Object.entries(FILES) as [keyof RecordSet, string][]) writeNdjson(join(out, file), set[key]);
  writeNdjson(join(out, SYSTEM_FILES.inputs), inputs);
  writeNdjson(join(out, SYSTEM_FILES.packages), fed.packages);
  writeNdjson(join(out, SYSTEM_FILES.traces), fed.traces);

  // Evidence locations for the packs.
  const evidence = new Map(set.evidence.map((e) => [e.id, e]));
  const where = (id: string) => {
    const e = evidence.get(id);
    if (!e) return null;
    return `${e.input}:${e.path}:${(e.span as Rec | undefined)?.startLine ?? '?'}`;
  };
  for (const [path, text] of buildPacks(fed, inputs, where)) {
    mkdirSync(dirname(join(out, path)), { recursive: true });
    writeFileSync(join(out, path), text);
  }
  const configurationHash = sha256Hex(canonical(fed.config.canonical));
  writeIndex(join(out, 'index.sqlite'), set, { system: fed.config.system, engine: `${ENGINE.name}@${ENGINE.version}`, schemaVersion: SCHEMA_VERSION, systemFormat: SYSTEM_FORMAT, configurationHash }, { inputs, packages: fed.packages, traces: fed.traces });

  const excluded = fed.states.filter((s) => !s.input);
  const partialInputs = fed.inputs.filter((i) => i.manifest.status === 'partial' || fed.states.find((s) => s.name === i.name)!.verification.references.length);
  const status: WriteResult['status'] = fed.inputs.length === 0 ? 'failed' : excluded.length || partialInputs.length ? 'partial' : 'complete';
  const projects = fed.inputs.flatMap((i) =>
    (((i.manifest.coverage?.projects as Rec[] | undefined) ?? []) as Rec[]).map((p) => ({ ...p, input: i.name, project: typeof p.project === 'string' ? `${i.name}/${p.project}` : p.project })),
  );
  const summary: Record<string, number> = { total: 0, semantic: 0, syntax: 0, failed: 0, notAnalyzed: 0 };
  for (const i of fed.inputs) for (const [k, v] of Object.entries((i.manifest.coverage?.summary as Record<string, number> | undefined) ?? {})) summary[k] = (summary[k] ?? 0) + (typeof v === 'number' ? v : 0);
  const manifest = {
    schemaVersion: SCHEMA_VERSION,
    generationType: 'system',
    systemFormat: SYSTEM_FORMAT,
    system: fed.config.system,
    requiredCapabilities: [] as string[],
    status,
    engine: ENGINE,
    imageDigest: process.env.FEDERATION_IMAGE_DIGEST || 'unknown',
    // A system has no single repository: the commit is a content hash of the inputs' manifests.
    repository: { remoteUrl: null },
    commit: `system:${sha256Hex(canonical(inputs.map((i) => [i.id, i.commit, i.manifestSha256])))}`,
    dirty: fed.inputs.some((i) => i.manifest.dirty === true),
    configurationHash,
    analysisContexts: fed.inputs.flatMap((i) => ((i.manifest.analysisContexts as string[] | undefined) ?? []).map((c) => `${i.name}/${c}`)).sort(compareOrdinal),
    coverage: { projects, summary, inputs: { total: fed.states.length, included: fed.inputs.length, excluded: excluded.length } },
    inputs: inputs.map((i) => ({ name: i.id, commit: i.commit, manifestSha256: i.manifestSha256, included: i.included })),
    files: fileList(out),
  };
  writeFileSync(join(out, 'manifest.json'), canonical(manifest) + '\n');
  const counts: Record<string, number> = {
    inputs: fed.states.length,
    includedInputs: fed.inputs.length,
    systemLinks: fed.links.length,
    packageLinks: fed.packageLinks.length,
    packages: fed.packages.length,
    traces: fed.traces.length,
  };
  for (const [key, list] of Object.entries(set)) counts[key] = (list as Rec[]).length;
  const run = { engine: ENGINE, startedAt: new Date(startedAt).toISOString(), finishedAt: new Date().toISOString(), elapsedMs: Date.now() - startedAt, counts, host: { os: process.platform, architecture: process.arch, node: process.version } };
  writeFileSync(join(out, 'run.json'), JSON.stringify(run, null, 2) + '\n');
  return { status, counts };
}

export interface VerifyResult {
  ok: boolean;
  errors: string[];
  notes: string[];
}

/** verify <system generation>: manifest, checksums, unlisted files, records (prefixed schemas), system references. */
export function verifySystemGeneration(dir: string, inputDirs: Map<string, string> = new Map()): VerifyResult {
  const errors: string[] = [];
  const notes: string[] = [];
  const manifestPath = join(dir, 'manifest.json');
  if (!existsSync(manifestPath)) return { ok: false, errors: ['manifest.json is missing: not a complete system generation'], notes };
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, any>;
  errors.push(...validate(schemaFor('manifest', true), manifest).map((e) => `manifest.json ${e}`));
  if (manifest.generationType !== 'system') errors.push(`manifest.json generationType is ${manifest.generationType}, expected system`);
  if (String(manifest.schemaVersion ?? '').split('.')[0] !== '1') errors.push(`schemaVersion ${manifest.schemaVersion}: only major 1 is supported`);
  for (const cap of manifest.requiredCapabilities ?? []) errors.push(`unknown required capability '${cap}': refusing the generation`);
  const listed = new Map<string, { sha256: string; size: number }>((manifest.files ?? []).map((f: any) => [f.path, f]));
  const present = new Set(walk(dir).filter((p) => p !== 'manifest.json' && p !== 'run.json'));
  for (const [path, f] of [...listed].sort(([a], [b]) => compareOrdinal(a, b))) {
    if (!present.has(path)) {
      errors.push(`${path}: listed in the manifest but missing`);
      continue;
    }
    const bytes = readFileSync(join(dir, path));
    const sha = createHash('sha256').update(bytes).digest('hex');
    if (sha !== f.sha256) errors.push(`${path}: checksum mismatch`);
    if (bytes.length !== f.size) errors.push(`${path}: size mismatch`);
  }
  for (const p of [...present].sort(compareOrdinal)) if (!listed.has(p)) errors.push(`${p}: present but not listed in the manifest`);
  const set = readRecords(dir);
  const integrity = checkIntegrity(set, { system: true });
  errors.push(...integrity.errors);
  for (const r of integrity.references) notes.push(`dangling reference carried from an input: ${r}`);
  notes.push(...integrity.notes);
  const inputs = readNdjson(join(dir, SYSTEM_FILES.inputs));
  const names = new Set(inputs.map((i) => i.id));
  for (let i = 1; i < inputs.length; i++) if (compareOrdinal(inputs[i - 1].id, inputs[i].id) >= 0) errors.push(`inputs.ndjson: ids not sorted and unique at ${inputs[i].id}`);
  const included = new Set(inputs.filter((i) => i.included).map((i) => i.id));
  for (const key of Object.keys(FILES) as (keyof RecordSet)[])
    for (const r of set[key]) {
      const slash = r.id.indexOf('/');
      if (slash > 0) {
        const input = r.id.slice(0, slash);
        if (!included.has(input)) errors.push(`${FILES[key]} ${r.id}: input ${input} is not an included input`);
        if (r.input !== input) errors.push(`${FILES[key]} ${r.id}: input field ${String(r.input)} does not match the id prefix`);
      }
    }
  const linkIds = new Set(set.links.map((l) => l.id));
  for (const l of set.links.filter((x) => x.scope === 'system')) {
    for (const side of ['from', 'to'] as const) {
      const e = l[side] as Rec | null;
      if (e && !names.has(e.input as string)) errors.push(`link ${l.id}: unknown ${side} input ${String(e.input)}`);
      const through = (e?.through as Rec | undefined)?.packageLink as string | undefined;
      if (through && !linkIds.has(through)) errors.push(`link ${l.id}: unknown package link ${through}`);
    }
  }
  const packages = readNdjson(join(dir, SYSTEM_FILES.packages));
  for (const p of packages) {
    if (!/^pkr:[0-9a-f]{32}$/.test(p.id)) errors.push(`packages.ndjson ${p.id}: id does not match ^pkr:[0-9a-f]{32}$`);
    if (!names.has((p.consumer as Rec).input as string)) errors.push(`packages.ndjson ${p.id}: unknown consumer input`);
  }
  const traces = readNdjson(join(dir, SYSTEM_FILES.traces));
  for (const t of traces) for (const id of t.links as string[]) if (!linkIds.has(id)) errors.push(`traces.ndjson ${t.id}: unknown link ${id}`);
  // Optional: the inputs themselves, against the manifest digests recorded in inputs.ndjson.
  for (const [name, path] of inputDirs) {
    const rec = inputs.find((i) => i.id === name);
    if (!rec) errors.push(`--input ${name}: not an input of this system generation`);
    else if (!existsSync(join(path, 'manifest.json'))) errors.push(`--input ${name}: no manifest.json in ${path}`);
    else if (sha256Hex(readFileSync(join(path, 'manifest.json'))) !== rec.manifestSha256) errors.push(`--input ${name}: manifest.json differs from the one federated (sha256 ${rec.manifestSha256})`);
  }
  if (!inputDirs.size) notes.push('input generations not given: their manifest digests are recorded in inputs.ndjson but not re-checked');
  notes.push('repository blob ids are not checked without the repositories');
  return { ok: errors.length === 0, errors, notes };
}

export function indexDump(dir: string): string {
  return dumpIndex(join(dir, 'index.sqlite'));
}
