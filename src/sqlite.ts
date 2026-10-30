// index.sqlite over the union: the tables of the contract's index schema 1 (schema/index/v1/index.sql, sections base
// and system), so one reader (the MCP server) serves repository and system generations. Ids carry their input prefix;
// links whose side is an entity (implemented_by_package) store that entity in from_obs / to_obs. Derived data: the
// NDJSON files stay the source of truth; a canonical dump (sorted rows) is what must be identical across runs.
import { DatabaseSync } from 'node:sqlite';
import type { RecordSet, Rec } from './records.ts';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { SCHEMA_DIR } from './artifacts/schema.ts';
import { canonical, compareOrdinal } from './util/canonical.ts';

export function sqliteInfo(): { version: string; fts5: boolean } {
  const db = new DatabaseSync(':memory:');
  const version = String((db.prepare('select sqlite_version() as v').get() as { v: string }).v);
  let fts5 = true;
  try {
    db.exec('create virtual table t using fts5(x)');
  } catch {
    fts5 = false;
  }
  db.close();
  return { version, fts5 };
}

/** Statements of the given sections of the vendored schema/index/v1/index.sql (contract v1.2, index schema 1). */
function indexStatements(sections: string[]): string[] {
  const text = readFileSync(join(SCHEMA_DIR, '..', 'index', 'v1', 'index.sql'), 'utf8');
  const out: string[] = [];
  let section = '';
  for (const line of text.split('\n')) {
    const header = /^-- (base|evidence|system)$/.exec(line.trim());
    if (header) section = header[1];
    else if (sections.includes(section) && line.trim() && !line.startsWith('--')) out.push(line.trim());
  }
  return out;
}

export interface SystemExtras {
  inputs: Rec[];
  packages: Rec[];
  traces: Rec[];
}

export function writeIndex(path: string, set: RecordSet, meta: Record<string, string>, extras: SystemExtras): void {
  const db = new DatabaseSync(path);
  db.exec('pragma journal_mode = off; pragma synchronous = off;');
  for (const statement of indexStatements(['base', 'system'])) db.exec(statement);
  db.exec('begin');
  const evidence = new Map<string, Rec>(set.evidence.map((e) => [e.id, e]));
  const snippets = new Map<string, Rec>(set.snippets.map((s) => [s.id, s]));
  // The first evidence by location (path ordinal, start line, start column), or the observation's `site`.
  const firstEvidence = (ids: unknown, site?: unknown) => {
    if (typeof site === 'string' && evidence.has(site)) return evidence.get(site);
    const list = (ids as string[]).map((id) => evidence.get(id)).filter((e): e is Rec => !!e);
    list.sort((a, b) => {
      const sa = a.span as { startLine: number; startColumn: number };
      const sb = b.span as { startLine: number; startColumn: number };
      return compareOrdinal(a.path as string, b.path as string) || sa.startLine - sb.startLine || sa.startColumn - sb.startColumn;
    });
    return list[0];
  };
  const insertMeta = db.prepare('insert into meta values (?, ?)');
  for (const [k, v] of Object.entries(meta).sort()) insertMeta.run(k, v);
  const ent = db.prepare('insert into entities values (?, ?, ?, ?, ?, ?, ?, ?)');
  const search = db.prepare('insert into search values (?, ?, ?)');
  for (const e of set.entities) {
    ent.run(e.id, e.kind as string, e.name as string, (e.container as string) ?? null, e.signature as string, (e.project as string) ?? null, e.origin as string, canonical(e));
    search.run(e.id, 'entity', `${e.name} ${e.signature} ${e.kind}`);
  }
  const decl = db.prepare('insert into declarations values (?, ?, ?, ?, ?, ?)');
  for (const d of set.declarations) {
    const span = d.span as { startLine: number; startColumn: number };
    decl.run(d.id, d.entity as string, d.context as string, d.path as string, span.startLine, span.startColumn);
  }
  const ev = db.prepare('insert into evidence values (?, ?, ?, ?, ?, ?, ?, ?, ?)');
  for (const e of set.evidence) {
    const span = e.span as { startLine: number; startColumn: number; endLine: number; endColumn: number };
    const text = e.snippet ? (snippets.get(e.snippet as string)?.text as string) ?? null : null;
    ev.run(e.id, e.path as string, span.startLine, span.startColumn, span.endLine, span.endColumn, e.method as string, e.context as string, text);
  }
  for (const s of set.snippets) search.run(s.id, 'snippet', s.text as string);
  const rel = db.prepare('insert into relations values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
  for (const r of set.relations) {
    const e = firstEvidence(r.evidence);
    const span = e?.span as { startLine: number } | undefined;
    rel.run(r.id, r.kind as string, r.from as string, r.to as string, (r.usage as string) ?? null, r.resolution as string, r.context as string, (e?.path as string) ?? null, span?.startLine ?? null, (r.declaredTarget as string) ?? null);
  }
  const obs = db.prepare('insert into observations values (?, ?, ?, ?, ?, ?)');
  for (const o of set.observations) {
    const e = firstEvidence(o.evidence, o.site);
    const span = e?.span as { startLine: number } | undefined;
    obs.run(o.id, o.kind as string, o.project as string, (e?.path as string) ?? null, span?.startLine ?? null, canonical(o));
  }
  const lnk = db.prepare('insert into links values (?, ?, ?, ?, ?, ?, ?)');
  for (const l of set.links) {
    const end = (e: Rec | null) => (e ? ((e.observation ?? e.entity ?? null) as string | null) : null);
    lnk.run(l.id, l.kind as string, l.via as string, end(l.from as Rec), end(l.to as Rec | null), l.resolution as string, (l.reason as string) ?? null);
  }
  const diag = db.prepare('insert into diagnostics values (?, ?, ?, ?, ?, ?)');
  for (const d of set.diagnostics) diag.run(d.id, d.severity as string, d.code as string, d.scope as string, d.state as string, d.message as string);
  const prj = db.prepare('insert into projects values (?, ?, ?, ?)');
  for (const p of set.projects) prj.run(p.id, p.recordType as string, (p.path ?? p.project) as string, canonical(p));
  const inp = db.prepare('insert into inputs values (?, ?)');
  for (const i of extras.inputs) {
    inp.run(i.id, canonical(i));
    search.run(i.id, 'input', `${i.id} ${(i.repository as Rec | null)?.remoteUrl ?? ''}`);
  }
  const pkg = db.prepare('insert into packages values (?, ?, ?, ?, ?, ?, ?, ?)');
  for (const p of extras.packages) pkg.run(p.id, p.packageId as string, p.version as string, (p.consumer as Rec).input as string, ((p.producer as Rec | null)?.input as string) ?? null, p.versionMatch as string, p.resolution as string, canonical(p));
  const trc = db.prepare('insert into traces values (?, ?, ?, ?, ?)');
  for (const t of extras.traces) trc.run(t.id, t.start as string, t.end as string, t.resolution as string, canonical(t));
  db.exec('commit');
  db.close();
}

/** Canonical dump: every table, rows sorted, one JSON array per line. */
export function dumpIndex(path: string): string {
  const db = new DatabaseSync(path, { readOnly: true });
  const tables = (db.prepare("select name from sqlite_master where type = 'table' and name not like 'search_%' and name not like 'sqlite_%' order by name").all() as { name: string }[]).map((t) => t.name);
  const lines: string[] = [];
  for (const t of tables) {
    const rows = db.prepare(`select * from "${t}"`).all() as Record<string, unknown>[];
    const encoded = rows.map((r) => canonical(Object.values(r).map((v) => (typeof v === 'bigint' ? Number(v) : v)))).sort();
    for (const row of encoded) lines.push(`${t}\t${row}`);
  }
  db.close();
  return lines.join('\n') + '\n';
}
