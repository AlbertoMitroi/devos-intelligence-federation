// Record checks shared by input verification and system verification (contract v1 Validation): schema per record,
// sorted unique ids, every referenced id exists. In a system generation every id may carry an `{input}/` prefix; the
// schemas are applied with their id patterns widened accordingly (proposal: docs/SYSTEM-GENERATION.md).
import { schema, validate } from './artifacts/schema.ts';
import { compareOrdinal } from './util/canonical.ts';
import { FILES, type Rec, type RecordSet } from './records.ts';

export const KNOWN_RELATION_KINDS = new Set(['declares', 'contains', 'references', 'calls_declared_target', 'overrides', 'implements', 'inherits', 'possible_runtime_target']);
export const KNOWN_OBSERVATION_KINDS = new Set([
  'di.registers', 'di.consumes', 'http.endpoint', 'http.call', 'grpc.proto', 'grpc.service', 'grpc.call', 'messaging.publish', 'messaging.subscribe', 'config.key',
  'topology.resource', 'topology.reference', 'data.maps_to',
  'inprocess.send', 'inprocess.handler', 'eventstore.append', 'eventstore.projection', 'realtime.hub', 'realtime.send', 'realtime.subscribe', 'search.index',
  'workflow.process', 'workflow.node', 'workflow.flow', 'workflow.handler', 'data.table', 'infra.resource', 'ui.component', 'ui.uses_component', 'ui.route',
]);
export const KNOWN_LINK_KINDS = new Set(['consumes_contract', 'configured_route', 'possible_communication', 'dispatches_to', 'implemented_by_package', 'pushes_to']);

const SCHEMA_OF: Record<keyof RecordSet, string> = {
  projects: 'project',
  entities: 'entity',
  declarations: 'declaration',
  relations: 'relation',
  evidence: 'evidence',
  observations: 'observation',
  links: 'link',
  diagnostics: 'diagnostic',
  snippets: 'snippet',
};

export const INPUT_NAME = /^[a-z0-9][a-z0-9-]*$/;
const PREFIX = '(?:[a-z0-9][a-z0-9-]*/)?';

/** The contract schema with every anchored pattern accepting an optional `{input}/` prefix. */
function prefixed(s: unknown): unknown {
  if (Array.isArray(s)) return s.map(prefixed);
  if (s && typeof s === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(s)) out[k] = k === 'pattern' && typeof v === 'string' && v.startsWith('^') ? '^' + PREFIX + v.slice(1) : prefixed(v);
    return out;
  }
  return s;
}

const prefixedCache = new Map<string, Record<string, any>>();
export function schemaFor(name: string, system: boolean): Record<string, any> {
  if (!system) return schema(name);
  let s = prefixedCache.get(name);
  if (!s) prefixedCache.set(name, (s = prefixed(schema(name)) as Record<string, any>));
  return s;
}

const ENTITY_REF = /^(?:[a-z0-9][a-z0-9-]*\/)?(?:dotnet|ts):/;
/** Keys whose values are free text, never references. */
const TEXT_KEYS = new Set(['text', 'message', 'reason', 'signature', 'documentationId', 'urlTemplate', 'routeTemplate', 'name', 'fullName', 'template']);

function entityRefs(value: unknown, out: string[], key = ''): void {
  if (TEXT_KEYS.has(key)) return;
  if (typeof value === 'string') {
    if (ENTITY_REF.test(value)) out.push(value);
  } else if (Array.isArray(value)) value.forEach((v) => entityRefs(v, out, key));
  else if (value && typeof value === 'object') for (const [k, v] of Object.entries(value)) entityRefs(v, out, k);
}

export interface IntegrityResult {
  /** Structure: schema, sorting, uniqueness. */
  errors: string[];
  /** Dangling references (an id that names no record). */
  references: string[];
  notes: string[];
}

export interface IntegrityOptions {
  /** System generation: ids may be prefixed and system links may point at entities instead of observations. */
  system?: boolean;
  maxErrors?: number;
}

export function checkIntegrity(set: RecordSet, options: IntegrityOptions = {}): IntegrityResult {
  const system = options.system ?? false;
  const errors: string[] = [];
  const references: string[] = [];
  const notes: string[] = [];
  const max = options.maxErrors ?? 50;
  const sink = (list: string[]) => (m: string) => {
    if (list.length < max) list.push(m);
    else if (list.length === max) list.push('... further messages omitted');
  };
  const err = sink(errors);
  const ref = sink(references);
  for (const key of Object.keys(FILES) as (keyof RecordSet)[]) {
    const records = set[key];
    for (let i = 0; i < records.length; i++) {
      const r = records[i];
      const s = key === 'projects' && r.recordType === 'analysisContext' ? schemaFor('analysis-context', system) : schemaFor(SCHEMA_OF[key], system);
      for (const e of validate(s, r)) err(`${FILES[key]} ${r.id ?? `#${i + 1}`}: ${e}`);
      if (i > 0 && compareOrdinal(records[i - 1].id, r.id) >= 0) err(`${FILES[key]}: ids not sorted and unique at ${r.id}`);
    }
  }
  const ids = (list: Rec[]) => new Set(list.map((r) => r.id));
  const entities = ids(set.entities);
  const evidence = ids(set.evidence);
  const observations = ids(set.observations);
  const snippets = ids(set.snippets);
  const contexts = new Set(set.projects.filter((p) => p.recordType === 'analysisContext').map((p) => p.id));
  const projectIds = new Set(set.projects.filter((p) => p.recordType === 'project').map((p) => p.id));
  // A project is identified by its path inside its input.
  const projectKey = (input: unknown, path: unknown) => `${input ?? ''}\u0000${path}`;
  const projectPaths = new Set(set.projects.filter((p) => p.recordType === 'project').map((p) => projectKey(p.input, p.path)));
  for (const c of set.projects.filter((p) => p.recordType === 'analysisContext')) {
    if (!projectIds.has(c.projectId as string)) ref(`context ${c.id}: unknown project ${c.projectId}`);
  }
  for (const e of set.entities) {
    if (e.container !== null && e.container !== undefined && !entities.has(e.container as string)) ref(`entity ${e.id}: unknown container ${e.container}`);
  }
  for (const d of set.declarations) {
    if (!entities.has(d.entity as string)) ref(`declaration ${d.id}: unknown entity ${d.entity}`);
    if (!contexts.has(d.context as string)) ref(`declaration ${d.id}: unknown context ${d.context}`);
  }
  const unknownKinds = new Map<string, number>();
  const countUnknown = (k: string) => unknownKinds.set(k, (unknownKinds.get(k) ?? 0) + 1);
  for (const r of set.relations) {
    // `declares` starts at a project (contract v1 Layout).
    if (!entities.has(r.from as string) && !(r.kind === 'declares' && projectIds.has(r.from as string))) ref(`relation ${r.id}: unknown from ${r.from}`);
    if (!entities.has(r.to as string)) ref(`relation ${r.id}: unknown to ${r.to}`);
    if (r.declaredTarget !== undefined && r.declaredTarget !== null && !entities.has(r.declaredTarget as string)) ref(`relation ${r.id}: unknown declaredTarget ${r.declaredTarget}`);
    if (!contexts.has(r.context as string)) ref(`relation ${r.id}: unknown context ${r.context}`);
    for (const e of r.evidence as string[]) if (!evidence.has(e)) ref(`relation ${r.id}: unknown evidence ${e}`);
    if (!KNOWN_RELATION_KINDS.has(r.kind as string)) countUnknown(`relation ${r.kind}`);
  }
  for (const e of set.evidence) {
    if (e.context !== undefined && !contexts.has(e.context as string)) ref(`evidence ${e.id}: unknown context ${e.context}`);
    if (e.snippet !== undefined && e.snippet !== null && !snippets.has(e.snippet as string)) ref(`evidence ${e.id}: unknown snippet ${e.snippet}`);
  }
  for (const o of set.observations) {
    if (!contexts.has(o.context as string)) ref(`observation ${o.id}: unknown context ${o.context}`);
    if (!projectPaths.has(projectKey(o.input, o.project))) ref(`observation ${o.id}: unknown project ${o.project}`);
    for (const e of o.evidence as string[]) if (!evidence.has(e)) ref(`observation ${o.id}: unknown evidence ${e}`);
    const refs: string[] = [];
    const { id: _id, evidence: _ev, ...fields } = o;
    entityRefs(fields, refs);
    for (const r of refs) if (!entities.has(r)) ref(`observation ${o.id}: unknown entity ${r}`);
    if (!KNOWN_OBSERVATION_KINDS.has(o.kind as string)) countUnknown(`observation ${o.kind}`);
  }
  for (const l of set.links) {
    const from = l.from as Rec;
    const to = l.to as Rec | null;
    const endpoint = (side: string, e: Rec) => {
      if (e.observation !== null && e.observation !== undefined) {
        if (!observations.has(e.observation as string)) ref(`link ${l.id}: unknown ${side} observation ${e.observation}`);
      } else if (system && typeof e.entity === 'string') {
        if (!entities.has(e.entity)) ref(`link ${l.id}: unknown ${side} entity ${e.entity}`);
      } else err(`link ${l.id}: ${side} names neither an observation nor an entity`);
      if (system && typeof e.entity === 'string' && !entities.has(e.entity)) ref(`link ${l.id}: unknown ${side} entity ${e.entity}`);
    };
    endpoint('from', from);
    if (to) endpoint('to', to);
    if (!to && l.resolution !== 'unresolved') err(`link ${l.id}: no target but resolution ${l.resolution}`);
    if (l.resolution === 'unresolved' && !l.reason) err(`link ${l.id}: unresolved without a reason`);
    for (const e of l.evidence as string[]) if (!evidence.has(e)) ref(`link ${l.id}: unknown evidence ${e}`);
    if (!KNOWN_LINK_KINDS.has(l.kind as string)) countUnknown(`link ${l.kind}`);
  }
  for (const [k, n] of [...unknownKinds].sort(([a], [b]) => compareOrdinal(a, b))) notes.push(`kind not in contract v1.1: ${k} (${n} records; kept, excluded from linking)`);
  return { errors, references, notes };
}
