// One input generation: verification (PLAN pipeline 1), inventory record (pipeline 2) and the lookups the linkers use.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { schema, validate } from './artifacts/schema.ts';
import { compareOrdinal } from './util/canonical.ts';
import { checkIntegrity } from './integrity.ts';
import { readRecords, type Rec, type RecordSet } from './records.ts';

export const KNOWN_CAPABILITIES = new Set<string>();

export interface InputVerification {
  /** No structural error: the input is used. */
  ok: boolean;
  errors: string[];
  /** Dangling references inside the input: reported, the input is still used. */
  references: string[];
  notes: string[];
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

export function sha256File(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

/** Engine-independent `verify` of one generation: manifest schema, major, capabilities, checksums, unlisted files, records. */
export function verifyInput(dir: string, set?: RecordSet): InputVerification {
  const errors: string[] = [];
  const notes: string[] = [];
  const manifestPath = join(dir, 'manifest.json');
  if (!existsSync(manifestPath)) return { ok: false, errors: ['manifest.json is missing: not a complete generation'], references: [], notes };
  let manifest: Record<string, any>;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  } catch (e) {
    return { ok: false, errors: [`manifest.json is not JSON: ${(e as Error).message}`], references: [], notes };
  }
  errors.push(...validate(schema('manifest'), manifest).map((e) => `manifest.json ${e}`));
  if (String(manifest.schemaVersion ?? '').split('.')[0] !== '1') errors.push(`schemaVersion ${manifest.schemaVersion}: only major 1 is supported`);
  for (const cap of manifest.requiredCapabilities ?? []) if (!KNOWN_CAPABILITIES.has(cap)) errors.push(`unknown required capability '${cap}': refusing the generation`);
  if (manifest.status === 'failed') errors.push('manifest status is failed');
  const listed = new Map<string, { sha256: string; size: number }>();
  for (const f of manifest.files ?? []) listed.set(f.path, f);
  // index.sqlite is derived data written after the manifest by some engines; it is never part of the federation's input.
  const ignored = new Set(['manifest.json', 'run.json']);
  if (!listed.has('index.sqlite')) ignored.add('index.sqlite');
  const present = new Set(walk(dir).filter((p) => !ignored.has(p) && !p.endsWith('.DS_Store')));
  for (const [path, f] of [...listed].sort(([a], [b]) => compareOrdinal(a, b))) {
    if (!present.has(path)) {
      errors.push(`${path}: listed in the manifest but missing`);
      continue;
    }
    const bytes = readFileSync(join(dir, path));
    const sha = createHash('sha256').update(bytes).digest('hex');
    if (sha !== f.sha256) errors.push(`${path}: checksum mismatch (manifest ${f.sha256}, file ${sha})`);
    if (bytes.length !== f.size) errors.push(`${path}: size mismatch (manifest ${f.size}, file ${bytes.length})`);
  }
  for (const p of [...present].sort(compareOrdinal)) if (!listed.has(p)) errors.push(`${p}: present but not listed in the manifest`);
  if (manifest.status === 'partial') notes.push('manifest status is partial: the input is used, its gaps are in its diagnostics');
  let records: RecordSet;
  try {
    records = set ?? readRecords(dir);
  } catch (e) {
    errors.push(`records could not be read: ${(e as Error).message}`);
    return { ok: false, errors, references: [], notes };
  }
  const integrity = checkIntegrity(records);
  errors.push(...integrity.errors);
  notes.push(...integrity.notes);
  return { ok: errors.length === 0, errors, references: integrity.references, notes };
}

const TEST_PACKAGES = new Set(['Microsoft.NET.Test.Sdk', 'xunit', 'xunit.v3', 'NUnit', 'MSTest.TestFramework', 'MSTest']);

/** A loaded input with the lookups the linkers need. Ids here are the input's own (not prefixed). */
export class Input {
  readonly name: string;
  readonly dir: string;
  readonly manifest: Record<string, any>;
  readonly manifestSha256: string;
  readonly set: RecordSet;
  readonly entities = new Map<string, Rec>();
  readonly evidence = new Map<string, Rec>();
  readonly observationsByKind = new Map<string, Rec[]>();
  readonly relationsFrom = new Map<string, Rec[]>();
  readonly relationsTo = new Map<string, Rec[]>();
  /** analysisContext id -> project path */
  readonly contextProject = new Map<string, string>();
  readonly projects = new Map<string, Rec>();
  readonly testProjects = new Set<string>();
  readonly configKeys = new Map<string, Rec[]>();

  constructor(name: string, dir: string) {
    this.name = name;
    this.dir = dir;
    const manifestPath = join(dir, 'manifest.json');
    this.manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    this.manifestSha256 = sha256File(manifestPath);
    this.set = readRecords(dir);
    for (const e of this.set.entities) this.entities.set(e.id, e);
    for (const e of this.set.evidence) this.evidence.set(e.id, e);
    for (const o of this.set.observations) {
      const list = this.observationsByKind.get(o.kind as string) ?? [];
      list.push(o);
      this.observationsByKind.set(o.kind as string, list);
      if (o.kind === 'config.key') {
        const keys = this.configKeys.get(o.key as string) ?? [];
        keys.push(o);
        this.configKeys.set(o.key as string, keys);
      }
    }
    for (const r of this.set.relations) {
      push(this.relationsFrom, r.from as string, r);
      push(this.relationsTo, r.to as string, r);
    }
    for (const p of this.set.projects) {
      if (p.recordType === 'project') {
        this.projects.set(p.path as string, p);
        const packages = (p.packages as { id: string }[] | undefined) ?? [];
        if (packages.some((x) => TEST_PACKAGES.has(x.id))) this.testProjects.add(p.path as string);
      } else if (p.recordType === 'analysisContext') this.contextProject.set(p.id, p.project as string);
    }
  }

  observations(kind: string): Rec[] {
    return this.observationsByKind.get(kind) ?? [];
  }

  /** Project path of the entity: from the entity record, else from the id (`dotnet:{project}:...`, `ts:{project}:...`). */
  projectOf(entityId: string): string | null {
    const e = this.entities.get(entityId);
    if (e && typeof e.project === 'string') return e.project;
    const m = /^(?:dotnet|ts):(?!pkg:)([^:]+):/.exec(entityId);
    return m ? m[1] : null;
  }

  isTestEntity(entityId: string): boolean {
    const p = this.projectOf(entityId);
    return p !== null && this.testProjects.has(p);
  }

  remoteUrl(): string | null {
    return (this.manifest.repository?.remoteUrl as string | undefined) ?? null;
  }
}

function push<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}
