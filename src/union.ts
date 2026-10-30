// The union of the inputs' records (PLAN "Identity"): every record keeps its input's id prefixed with the input name
// (`leasing/rel:...`), every reference inside it is prefixed the same way, and the record gains `input`. Paths stay
// repository-relative; `input` says which repository.
import { compareOrdinal } from './util/canonical.ts';
import type { Input } from './input.ts';
import { emptySet, FILES, type Rec, type RecordSet } from './records.ts';

const HASH_REF = /^(?:ev|obs|ctx|prj|snip|rel|decl|lnk|diag):[0-9a-f]{32}$/;
const ENTITY_REF = /^(?:dotnet|ts):/;
/** Free-text keys: their values are never references, whatever they look like. */
const TEXT_KEYS = new Set(['text', 'message', 'reason', 'signature', 'documentationId', 'urlTemplate', 'routeTemplate', 'name', 'fullName', 'template', 'value', 'path', 'file', 'key']);

export function prefixValue(value: unknown, input: string, key = ''): unknown {
  if (TEXT_KEYS.has(key)) return value;
  if (typeof value === 'string') return HASH_REF.test(value) || ENTITY_REF.test(value) ? `${input}/${value}` : value;
  if (Array.isArray(value)) return value.map((v) => prefixValue(v, input, key));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = prefixValue(v, input, k);
    return out;
  }
  return value;
}

export function prefixRecord(r: Rec, input: string): Rec {
  const out = prefixValue(r, input) as Rec;
  out.id = `${input}/${r.id}`;
  out.input = input;
  return out;
}

export function union(inputs: Input[]): RecordSet {
  const set = emptySet();
  for (const input of inputs)
    for (const key of Object.keys(FILES) as (keyof RecordSet)[]) for (const r of input.set[key]) set[key].push(prefixRecord(r, input.name));
  for (const key of Object.keys(FILES) as (keyof RecordSet)[]) set[key].sort((a, b) => compareOrdinal(a.id, b.id));
  return set;
}
