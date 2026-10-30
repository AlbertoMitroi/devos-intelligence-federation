// Constant call-site arguments used as destinations (contract v1.2, C7): a template observation inside a helper names
// the parameter that fills one of its destination fields (`destinationParameter`); `call.argument` observations at the
// helper's call sites carry the value. The linker substitutes it, one variant per call site and value.
import { compareOrdinal } from './util/canonical.ts';
import type { Input } from './input.ts';
import type { Resolution } from './packages.ts';
import type { Rec } from './records.ts';

export interface SiteArgument {
  /** prefixed id of the call.argument observation */
  observation: string;
  value: string | null;
  valueSource: string;
  resolution: Resolution;
  reason: string | null;
}

/** The parts of a site this module needs (structurally the linker's Site). */
export interface ArgumentSite {
  input: Input;
  observationInput: Input;
  observation: Rec;
  entity: string | null;
  project: string;
  evidence: string[];
  through: { packageEntity: string } | null;
  argument?: SiteArgument;
}

/** Field of the template that the parameter fills, when it is one of `fields`. */
export function destinationField(o: Rec, fields: string[]): { field: string; ordinal: number } | null {
  const dp = o.destinationParameter as Rec | undefined;
  if (!dp || typeof dp.field !== 'string' || typeof dp.ordinal !== 'number' || !fields.includes(dp.field)) return null;
  return { field: dp.field, ordinal: dp.ordinal };
}

/**
 * Variants of a site with its call-site values. A site without a template, or a template without matching
 * `call.argument` records, is returned unchanged (linking stays as in v1.1).
 */
export function withArguments<S extends ArgumentSite>(s: S, fields: string[]): S[] {
  const dest = destinationField(s.observation, fields);
  if (!dest) return [s];
  const input = s.input;
  let args: Rec[];
  if (s.through) {
    // Package helper: the consumer's call to the package symbol carries the value.
    args = input.observations('call.argument').filter((a) => a.caller === s.entity && a.callee === s.through!.packageEntity && a.ordinal === dest.ordinal);
  } else {
    // Helper in the same input: calls to the member or to the interface member it implements.
    const callees = new Set<string>(s.entity ? [s.entity] : []);
    if (s.entity) for (const r of input.relationsFrom.get(s.entity) ?? []) if (r.kind === 'implements' || r.kind === 'overrides') callees.add(r.to as string);
    args = input.observations('call.argument').filter((a) => callees.has(a.callee as string) && a.ordinal === dest.ordinal && !input.testProjects.has(a.project as string));
  }
  args = args.filter((a) => !a.role || (a.role as Rec).field === dest.field).sort((a, b) => compareOrdinal(a.id, b.id));
  if (!args.length) return [s];
  const seen = new Set<string>();
  const out: S[] = [];
  for (const a of args) {
    const key = `${a.caller}\u0000${a.value ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const ev = (a.evidence as string[]).map((e) => `${input.name}/${e}`);
    out.push({
      ...s,
      entity: s.through ? s.entity : (a.caller as string),
      project: s.through ? s.project : (a.project as string),
      evidence: [...new Set([...s.evidence, ...ev])].sort(compareOrdinal),
      argument: {
        observation: `${input.name}/${a.id}`,
        value: typeof a.value === 'string' ? a.value : null,
        valueSource: String(a.valueSource ?? 'unknown'),
        resolution: (a.resolution as Resolution) ?? (typeof a.value === 'string' ? 'exact' : 'unresolved'),
        reason: typeof a.reason === 'string' ? a.reason : null,
      },
    });
  }
  return out;
}

/** Canonical route of a substituted route or URL template value (contract v1 Routes). */
export function canonicalRoute(value: string): string {
  // The query starts at the first `?` outside a route parameter (`{id?}` is an optional parameter).
  let v = value.replace(/^[a-z]+:\/\/[^/]+/i, '').replace(/\?(?![^{]*\})[\s\S]*$/, '');
  v = v.replace(/\{[^}]*\*\*[^}]*\}/g, '{**}').replace(/\{[^}?]*\?\}/g, '{?}').replace(/\{[^}]*\}/g, (m) => (m === '{**}' || m === '{?}' ? m : '{}'));
  const segments = v.split('/').filter(Boolean).map((s) => (s.startsWith('{') ? s : s.toLowerCase()));
  return '/' + segments.join('/');
}
