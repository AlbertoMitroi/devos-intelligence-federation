// Record files of a generation (contract v1 Layout) and of a system generation (PLAN, "System generation format").
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { canonical, compareOrdinal } from './util/canonical.ts';

export type Rec = Record<string, unknown> & { id: string };

export interface RecordSet {
  projects: Rec[];
  entities: Rec[];
  declarations: Rec[];
  relations: Rec[];
  evidence: Rec[];
  observations: Rec[];
  links: Rec[];
  diagnostics: Rec[];
  snippets: Rec[];
}

export const FILES: Record<keyof RecordSet, string> = {
  projects: 'graph/projects.ndjson',
  entities: 'graph/entities.ndjson',
  declarations: 'graph/declarations.ndjson',
  relations: 'graph/relations.ndjson',
  evidence: 'graph/evidence.ndjson',
  observations: 'graph/observations.ndjson',
  links: 'graph/links.ndjson',
  diagnostics: 'graph/diagnostics.ndjson',
  snippets: 'snippets.ndjson',
};

/** Files only a system generation has. */
export const SYSTEM_FILES = {
  inputs: 'inputs.ndjson',
  packages: 'graph/packages.ndjson',
  traces: 'graph/traces.ndjson',
} as const;

export function emptySet(): RecordSet {
  return { projects: [], entities: [], declarations: [], relations: [], evidence: [], observations: [], links: [], diagnostics: [], snippets: [] };
}

export function readNdjson(path: string): Rec[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l) as Rec);
}

export function writeNdjson(path: string, records: Rec[]): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, records.map((r) => canonical(r) + '\n').join(''));
}

export function readRecords(dir: string): RecordSet {
  const set = emptySet();
  for (const [key, file] of Object.entries(FILES) as [keyof RecordSet, string][]) set[key] = readNdjson(join(dir, file));
  return set;
}

export function sortById(records: Rec[]): Rec[] {
  return records.sort((a, b) => compareOrdinal(a.id, b.id));
}
