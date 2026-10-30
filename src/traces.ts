// End-to-end traces (PLAN pipeline 5): chains of cross-repository links joined inside an input through bounded call
// paths and the input's own links (in-process dispatch, messages inside the repository). Each segment keeps its resolution and evidence; the trace
// takes the weakest.
import { compareOrdinal, recordId } from './util/canonical.ts';
import type { Input } from './input.ts';
import { pref, weakest, type Resolution } from './packages.ts';
import type { Rec } from './records.ts';

const MAX_DEPTH = 8;
const MAX_LINKS = 4;

function unprefix(id: string): { input: string; id: string } {
  const i = id.indexOf('/');
  return { input: id.slice(0, i), id: id.slice(i + 1) };
}

interface Edge {
  to: string;
  kind: string;
  resolution: Resolution;
  evidence: string[];
  link?: string;
}

/** Forward edges inside one input: calls, implementations of a called interface member, in-process dispatch, messages. */
class CallGraph {
  private readonly input: Input;
  private readonly edges = new Map<string, Edge[]>();
  private readonly containedBy = new Map<string, string[]>();

  constructor(input: Input) {
    this.input = input;
    const add = (from: string, e: Edge) => {
      const list = this.edges.get(from) ?? [];
      list.push(e);
      this.edges.set(from, list);
    };
    for (const r of input.set.relations) {
      const ev = (r.evidence as string[]).map((x) => pref(input.name, x));
      if (r.kind === 'calls_declared_target' || (r.kind === 'references' && r.usage === 'invocation')) add(r.from as string, { to: r.to as string, kind: 'call', resolution: r.resolution as Resolution, evidence: ev });
      else if (r.kind === 'possible_runtime_target') add(r.from as string, { to: r.to as string, kind: 'runtime-target', resolution: 'candidate', evidence: ev });
      else if (r.kind === 'implements' || r.kind === 'overrides') add(r.to as string, { to: r.from as string, kind: 'implementation', resolution: 'candidate', evidence: ev });
      else if (r.kind === 'contains') {
        const list = this.containedBy.get(r.from as string) ?? [];
        list.push(r.to as string);
        this.containedBy.set(r.from as string, list);
      }
    }
    // In-process dispatch: the sender reaches the handler (a type handler reaches its members).
    const observations = new Map(input.set.observations.map((o) => [o.id, o]));
    for (const l of input.set.links) {
      const messaging = l.kind === 'consumes_contract' && l.via === 'messaging';
      if ((l.kind !== 'dispatches_to' && !messaging) || !l.to || l.resolution === 'unresolved') continue;
      const from = observations.get((l.from as Rec).observation as string);
      const to = observations.get((l.to as Rec).observation as string);
      const sender = (from?.sender ?? from?.caller ?? from?.publisher) as string | undefined;
      const handler = (to?.handlerMethod ?? to?.handler) as string | undefined;
      if (!sender || !handler) continue;
      const ev = (l.evidence as string[]).map((x) => pref(input.name, x));
      add(sender, { to: handler, kind: messaging ? 'message' : 'dispatch', resolution: l.resolution as Resolution, evidence: ev, link: pref(input.name, l.id) });
    }
    for (const [from, list] of this.edges) list.sort((a, b) => compareOrdinal(a.to + a.kind, b.to + b.kind));
  }

  next(entity: string): Edge[] {
    const own = this.edges.get(entity) ?? [];
    // A type (handler class) continues into its members.
    const members = (this.containedBy.get(entity) ?? []).filter((m) => /:M:/.test(m) || /#/.test(m)).sort(compareOrdinal).map((m) => ({ to: m, kind: 'member', resolution: 'exact' as Resolution, evidence: [] }));
    return [...own, ...members];
  }

  /** Shortest bounded path from one of `starts` to `goal` (entity ids of this input), breadth first, deterministic. */
  path(starts: string[], goal: string): Edge[] | null {
    const prev = new Map<string, { from: string; edge: Edge } | null>();
    let frontier = [...new Set(starts)].sort(compareOrdinal);
    for (const s of frontier) prev.set(s, null);
    for (let d = 0; d <= MAX_DEPTH && frontier.length; d++) {
      const hit = frontier.find((f) => f === goal);
      if (hit !== undefined) {
        const edges: Edge[] = [];
        let cur = hit;
        while (prev.get(cur)) {
          const p = prev.get(cur)!;
          edges.unshift(p.edge);
          cur = p.from;
        }
        return edges;
      }
      const next: string[] = [];
      for (const f of frontier)
        for (const e of this.next(f))
          if (!prev.has(e.to)) {
            prev.set(e.to, { from: f, edge: e });
            next.push(e.to);
          }
      frontier = next;
    }
    return null;
  }

  get name(): string {
    return this.input.name;
  }
}

/** Entities a link enters in its target input: the endpoint handler, the message handler, the subscribing client. */
function entryEntities(link: Rec, input: Input): string[] {
  const to = link.to as Rec | null;
  if (!to) return [];
  const out: string[] = [];
  if (typeof to.entity === 'string') out.push(unprefix(to.entity).id);
  const obs = input.set.observations.find((o) => pref(input.name, o.id) === to.observation);
  if (obs && typeof obs.handlerMethod === 'string') out.push(obs.handlerMethod as string);
  if (obs && typeof obs.handler === 'string') out.push(obs.handler as string);
  return [...new Set(out)];
}

export function buildTraces(inputs: Input[], byName: Map<string, Input>, links: Rec[]): Rec[] {
  const graphs = new Map<string, CallGraph>();
  const graph = (name: string) => {
    let g = graphs.get(name);
    if (!g) graphs.set(name, (g = new CallGraph(byName.get(name)!)));
    return g;
  };
  const resolved = links.filter((l) => l.to && l.kind !== 'implemented_by_package');
  const outgoing = new Map<string, Rec[]>();
  for (const l of resolved) {
    const input = (l.from as Rec).input as string;
    const list = outgoing.get(input) ?? [];
    list.push(l);
    outgoing.set(input, list);
  }
  // Join A -> B when A enters input Y and B leaves Y from an entity reachable from A's entry.
  const joins = new Map<string, { next: Rec; path: Edge[] }[]>();
  for (const a of resolved) {
    const y = (a.to as Rec).input as string;
    const starts = entryEntities(a, byName.get(y)!);
    if (!starts.length) continue;
    for (const b of outgoing.get(y) ?? []) {
      if (b === a || typeof (b.from as Rec).entity !== 'string') continue;
      const goal = unprefix((b.from as Rec).entity as string).id;
      const path = graph(y).path(starts, goal);
      if (!path) continue;
      const list = joins.get(a.id) ?? [];
      list.push({ next: b, path });
      joins.set(a.id, list);
    }
  }
  const hasIncoming = new Set<string>();
  for (const list of joins.values()) for (const j of list) hasIncoming.add(j.next.id);
  const traces: Rec[] = [];
  const walk = (chain: { link: Rec; path: Edge[] }[]) => {
    const last = chain[chain.length - 1].link;
    const nexts = (joins.get(last.id) ?? []).filter((j) => !chain.some((c) => c.link.id === j.next.id));
    if (!nexts.length || chain.length >= MAX_LINKS) {
      if (chain.length >= 2) traces.push(trace(chain));
      return;
    }
    for (const j of nexts.sort((x, y) => compareOrdinal(x.next.id, y.next.id))) walk([...chain, { link: j.next, path: j.path }]);
  };
  for (const a of resolved.filter((l) => joins.has(l.id) && !hasIncoming.has(l.id)).sort((x, y) => compareOrdinal(x.id, y.id))) walk([{ link: a, path: [] }]);
  const unique = new Map(traces.map((t) => [t.id, t]));
  return [...unique.values()].sort((a, b) => compareOrdinal(a.id, b.id));
}

function trace(chain: { link: Rec; path: Edge[] }[]): Rec {
  const segments: Rec[] = [];
  const resolutions: Resolution[] = [];
  chain.forEach((c, i) => {
    if (i > 0) {
      const input = (c.link.from as Rec).input as string;
      for (const e of c.path) {
        segments.push({ id: '', type: 'inside', input, kind: e.kind, to: pref(input, e.to), resolution: e.resolution, evidence: e.evidence, ...(e.link ? { link: e.link } : {}) });
        resolutions.push(e.resolution);
      }
    }
    const l = c.link;
    segments.push({ id: '', type: 'link', link: l.id, kind: l.kind, via: l.via, from: (l.from as Rec).entity ?? (l.from as Rec).observation, to: (l.to as Rec).entity ?? (l.to as Rec).observation, fromInput: (l.from as Rec).input, toInput: (l.to as Rec).input, resolution: l.resolution, evidence: l.evidence });
    resolutions.push(l.resolution as Resolution);
  });
  for (const s of segments) delete (s as Partial<Rec>).id;
  const resolution = weakest(...resolutions);
  const weakestIndex = segments.findIndex((s) => s.resolution === resolution);
  const first = chain[0].link;
  const last = chain[chain.length - 1].link;
  const inputs = [...new Set(chain.flatMap((c) => [(c.link.from as Rec).input as string, (c.link.to as Rec).input as string]))];
  return {
    id: recordId('trc', chain.map((c) => c.link.id)),
    recordType: 'trace',
    start: (first.from as Rec).entity ?? (first.from as Rec).observation,
    end: (last.to as Rec).entity ?? (last.to as Rec).observation,
    inputs,
    links: chain.map((c) => c.link.id),
    segments,
    resolution,
    weakest: { segment: weakestIndex, resolution },
  };
}
