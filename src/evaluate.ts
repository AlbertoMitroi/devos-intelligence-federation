// Precision and recall of cross-repository links against hand-written expectations (tests/*/expected-links.yml).
// Precision counts every resolved system link (exact, ambiguous, candidate); recall counts expected links found.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import { compareOrdinal } from './util/canonical.ts';
import { readNdjson, SYSTEM_FILES, type Rec } from './records.ts';

interface Side {
  input: string;
  entity?: string;
  route?: string;
  package?: string;
  packageEntity?: string;
  method?: string;
}

interface ExpectedLink {
  id: string;
  ref?: string;
  via: string;
  from: Side;
  to?: Side;
}

interface ExpectedPackage {
  id: string;
  ref?: string;
  consumer: string;
  package: string;
  version: string;
  producer: string;
  versionMatch: string;
}

export interface Evaluation {
  system: string;
  totals: { expected: number; found: number; emitted: number; truePositives: number; falsePositives: number; precision: string; recall: string; exactPrecision: string };
  byVia: Record<string, { expected: number; found: number; emitted: number; truePositives: number; precision: string; recall: string }>;
  byResolution: Record<string, { emitted: number; truePositives: number }>;
  expected: { id: string; ref?: string; via: string; found: boolean; links: { id: string; resolution: string; reason?: string }[] }[];
  falsePositives: { id: string; via: string; resolution: string; from: string; to: string; reason?: string }[];
  unresolved: { id: string; ref?: string; found: boolean; reason?: string }[];
  unexpectedUnresolved: { id: string; from: string; reason?: string }[];
  packages: { id: string; ref?: string; found: boolean; producer: string | null; versionMatch: string | null; expectedVersionMatch: string; resolution: string | null; ok: boolean; reason?: string }[];
}

function ratio(n: number, d: number): string {
  return d === 0 ? 'n/a' : (n / d).toFixed(3);
}

function sideMatches(l: Rec, side: 'from' | 'to', s: Side | undefined): boolean {
  if (!s) return true;
  const e = l[side] as Rec | null;
  if (!e || e.input !== s.input) return false;
  const m = (l.match ?? {}) as Rec;
  if (s.entity && !(typeof e.entity === 'string' && e.entity.includes(s.entity))) return false;
  if (s.route && `${m.method ?? ''} ${m.endpointRoute ?? ''}` !== s.route) return false;
  if (s.method && m.method !== s.method) return false;
  const through = e.through as Rec | undefined;
  if (s.package && (through?.package as Rec | undefined)?.id !== s.package) return false;
  if (s.packageEntity && !(typeof through?.packageEntity === 'string' && (through.packageEntity as string).includes(s.packageEntity))) return false;
  return true;
}

const label = (e: Rec | null) => (e ? `${e.input}:${String(e.entity ?? e.observation)}` : 'null');

export function evaluate(dir: string, expectedFile: string): Evaluation {
  const spec = parse(readFileSync(expectedFile, 'utf8')) as { system: string; links?: ExpectedLink[]; unresolved?: ExpectedLink[]; packages?: ExpectedPackage[] };
  const links = readNdjson(join(dir, 'graph/links.ndjson')).filter((l) => l.scope === 'system' && l.kind !== 'implemented_by_package');
  const resolved = links.filter((l) => l.resolution !== 'unresolved');
  const unresolvedLinks = links.filter((l) => l.resolution === 'unresolved');
  const expected = spec.links ?? [];
  const matchedBy = new Map<string, string[]>();
  const result: Evaluation['expected'] = expected.map((x) => {
    const hits = resolved.filter((l) => l.via === x.via && sideMatches(l, 'from', x.from) && sideMatches(l, 'to', x.to));
    for (const h of hits) matchedBy.set(h.id, [...(matchedBy.get(h.id) ?? []), x.id]);
    return { id: x.id, ref: x.ref, via: x.via, found: hits.length > 0, links: hits.map((h) => ({ id: h.id, resolution: h.resolution as string, ...(h.reason ? { reason: h.reason as string } : {}) })) };
  });
  const fps = resolved.filter((l) => !matchedBy.has(l.id)).sort((a, b) => compareOrdinal(a.id, b.id));
  const vias = [...new Set([...expected.map((x) => x.via), ...resolved.map((l) => l.via as string)])].sort(compareOrdinal);
  const byVia: Evaluation['byVia'] = {};
  for (const via of vias) {
    const exp = result.filter((r) => r.via === via);
    const emitted = resolved.filter((l) => l.via === via);
    const tp = emitted.filter((l) => matchedBy.has(l.id)).length;
    byVia[via] = { expected: exp.length, found: exp.filter((r) => r.found).length, emitted: emitted.length, truePositives: tp, precision: ratio(tp, emitted.length), recall: ratio(exp.filter((r) => r.found).length, exp.length) };
  }
  const byResolution: Evaluation['byResolution'] = {};
  for (const r of ['exact', 'ambiguous', 'candidate']) {
    const emitted = resolved.filter((l) => l.resolution === r);
    byResolution[r] = { emitted: emitted.length, truePositives: emitted.filter((l) => matchedBy.has(l.id)).length };
  }
  const tp = resolved.length - fps.length;
  const found = result.filter((r) => r.found).length;
  const expectedUnresolved = spec.unresolved ?? [];
  const unresolvedMatched = new Set<string>();
  const unresolved = expectedUnresolved.map((x) => {
    const hit = unresolvedLinks.find((l) => l.via === x.via && sideMatches(l, 'from', x.from));
    if (hit) unresolvedMatched.add(hit.id);
    return { id: x.id, ref: x.ref, found: !!hit, ...(hit?.reason ? { reason: hit.reason as string } : {}) };
  });
  const packageRecords = readNdjson(join(dir, SYSTEM_FILES.packages));
  const packages = (spec.packages ?? []).map((x) => {
    const p = packageRecords.find((r) => (r.consumer as Rec).input === x.consumer && r.packageId === x.package && r.version === x.version);
    const producer = p ? ((p.producer as Rec).input as string) : null;
    const vm = p ? (p.versionMatch as string) : null;
    return { id: x.id, ref: x.ref, found: !!p, producer, versionMatch: vm, expectedVersionMatch: x.versionMatch, resolution: p ? (p.resolution as string) : null, ok: producer === x.producer && vm === x.versionMatch, ...(p?.reason ? { reason: p.reason as string } : {}) };
  });
  return {
    system: spec.system,
    totals: { expected: expected.length, found, emitted: resolved.length, truePositives: tp, falsePositives: fps.length, precision: ratio(tp, resolved.length), recall: ratio(found, expected.length), exactPrecision: ratio(byResolution.exact.truePositives, byResolution.exact.emitted) },
    byVia,
    byResolution,
    expected: result,
    falsePositives: fps.map((l) => ({ id: l.id, via: l.via as string, resolution: l.resolution as string, from: label(l.from as Rec), to: label(l.to as Rec), ...(l.reason ? { reason: l.reason as string } : {}) })),
    unresolved,
    unexpectedUnresolved: unresolvedLinks.filter((l) => !unresolvedMatched.has(l.id)).map((l) => ({ id: l.id, from: label(l.from as Rec), ...(l.reason ? { reason: l.reason as string } : {}) })),
    packages,
  };
}

export function renderReport(e: Evaluation): string {
  const t = e.totals;
  const out: string[] = [];
  out.push(`## Totals (${e.system})`, '');
  out.push(`- Precision **${t.precision}** (${t.truePositives} of ${t.emitted} resolved links match an expected link); precision of exact links ${t.exactPrecision}.`);
  out.push(`- Recall **${t.recall}** (${t.found} of ${t.expected} expected links found).`, '');
  out.push('| Via | Expected | Found | Recall | Emitted | Matching | Precision |', '|---|---|---|---|---|---|---|');
  for (const [via, v] of Object.entries(e.byVia)) out.push(`| ${via} | ${v.expected} | ${v.found} | ${v.recall} | ${v.emitted} | ${v.truePositives} | ${v.precision} |`);
  out.push('', '| Resolution | Emitted | Matching |', '|---|---|---|');
  for (const [r, v] of Object.entries(e.byResolution)) out.push(`| ${r} | ${v.emitted} | ${v.truePositives} |`);
  out.push('', '## Expected links', '', '| Expected | Ground truth | Found | Resolution |', '|---|---|---|---|');
  for (const x of e.expected) out.push(`| ${x.id} | ${x.ref ?? ''} | ${x.found ? 'yes' : '**no (miss)**'} | ${x.links.map((l) => l.resolution).join(', ') || '-'} |`);
  out.push('', '## Misses (expected, not found)', '');
  const misses = e.expected.filter((x) => !x.found);
  out.push(...(misses.length ? misses.map((m) => `- ${m.id} (${m.ref ?? ''})`) : ['None.']));
  out.push('', '## False positives (emitted, not expected)', '');
  out.push(...(e.falsePositives.length ? e.falsePositives.map((f) => `- ${f.via} ${f.resolution}: ${f.from} → ${f.to}${f.reason ? `. Reason recorded: ${f.reason}` : ''}`) : ['None.']));
  out.push('', '## Links with a non-exact resolution among the matches', '');
  const weak = e.expected.flatMap((x) => x.links.filter((l) => l.resolution !== 'exact').map((l) => `- ${x.id}: ${l.resolution}. ${l.reason ?? ''}`));
  out.push(...(weak.length ? weak : ['None.']));
  out.push('', '## Unresolved links (messages leaving the system)', '', '| Expected | Ground truth | Found | Reason |', '|---|---|---|---|');
  for (const u of e.unresolved) out.push(`| ${u.id} | ${u.ref ?? ''} | ${u.found ? 'yes' : '**no (miss)**'} | ${u.reason ?? ''} |`);
  if (e.unexpectedUnresolved.length) {
    out.push('', 'Unresolved links not in the expectations:', '');
    for (const u of e.unexpectedUnresolved) out.push(`- ${u.from}: ${u.reason ?? ''}`);
  }
  out.push('', '## Package to source', '', '| Expected | Producer | Version match (expected) | Resolution | Result |', '|---|---|---|---|---|');
  for (const p of e.packages) out.push(`| ${p.id} | ${p.producer ?? '-'} | ${p.versionMatch ?? '-'} (${p.expectedVersionMatch}) | ${p.resolution ?? '-'} | ${p.ok ? 'ok' : '**miss**'} |`);
  out.push('');
  return out.join('\n');
}
