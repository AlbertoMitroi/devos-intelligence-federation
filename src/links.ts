// Cross-repository links (PLAN pipeline 4), from normalized fields only: HTTP calls to endpoints, messages from
// publishers to subscribers, real-time sends to client subscriptions, in-process sends to handlers. A call, send or
// publish made inside a resolved package is attributed to the consumer's call site; a destination that is a parameter
// of a helper takes the constant recorded at the call site (contract v1.2, C7).
import { compareOrdinal, recordId } from './util/canonical.ts';
import { canonicalRoute, withArguments, type SiteArgument } from './arguments.ts';
import type { Input } from './input.ts';
import { pref, weakest, type EntityResolution, type PackageResolver, type Resolution } from './packages.ts';
import type { Rec } from './records.ts';
import type { SystemConfig } from './system.ts';

export interface LinkContext {
  config: SystemConfig;
  inputs: Input[];
  byName: Map<string, Input>;
  resolver: PackageResolver;
}

export interface LinkerResult {
  links: Rec[];
  /** Counts and notes that end in system diagnostics. */
  notes: { code: string; message: string; scope: string; state: 'partial' | 'unknown' | 'unsupported' }[];
}

/** An observation as seen from the input that owns the behaviour: direct, or reached through a package call site. */
export interface Site {
  /** input that owns the behaviour (the consumer for package-routed observations) */
  input: Input;
  /** input whose generation holds the observation */
  observationInput: Input;
  observation: Rec;
  /** entity that performs the call, send or publish (in `input`) */
  entity: string | null;
  project: string;
  evidence: string[];
  through: EntityResolution | null;
  /** call-site value of the observation's destination parameter (C7) */
  argument?: SiteArgument;
}

const ROLE: Record<string, string> = { 'http.call': 'caller', 'realtime.send': 'sender', 'messaging.publish': 'publisher', 'inprocess.send': 'sender' };

/** Link part resolution: an observation that is `unresolved` about some field still names a real site. */
function part(r: unknown): Resolution {
  if (r === 'exact' || r === 'ambiguous' || r === 'candidate') return r;
  return 'candidate';
}

function obsEvidence(input: Input, o: Rec): string[] {
  return (o.evidence as string[]).map((e) => pref(input.name, e));
}

function uniqSorted(values: Iterable<string>): string[] {
  return [...new Set(values)].sort(compareOrdinal);
}

function isInvocation(r: Rec): boolean {
  return r.kind === 'calls_declared_target' || (r.kind === 'references' && r.usage === 'invocation');
}

function isSourceEntity(id: string): boolean {
  return /^(?:dotnet|ts):/.test(id) && !/^(?:dotnet|ts):pkg:/.test(id);
}

/** Entities of `input` reachable from `start`: implementations and overrides, then bounded calls inside the input. */
function reach(input: Input, start: string, depth = 3): Set<string> {
  const seen = new Set<string>([start]);
  let frontier = [start];
  for (let d = 0; d <= depth && frontier.length; d++) {
    const next: string[] = [];
    for (const n of frontier) {
      for (const r of input.relationsTo.get(n) ?? []) {
        if ((r.kind === 'implements' || r.kind === 'overrides') && !seen.has(r.from as string)) {
          seen.add(r.from as string);
          next.push(r.from as string);
        }
      }
      if (d === depth) continue;
      for (const r of input.relationsFrom.get(n) ?? []) {
        const to = r.to as string;
        if (isInvocation(r) && isSourceEntity(to) && !seen.has(to)) {
          seen.add(to);
          next.push(to);
        }
      }
    }
    frontier = next;
  }
  return seen;
}

/** Direct and package-routed sites of the given observation kinds, test projects left out (counted). */
export function sites(ctx: LinkContext, kind: string, notes: LinkerResult['notes']): Site[] {
  const role = ROLE[kind];
  const out: Site[] = [];
  let testSites = 0;
  for (const input of ctx.inputs) {
    for (const o of input.observations(kind)) {
      const entity = (o[role] as string | null | undefined) ?? null;
      if (input.testProjects.has(o.project as string)) {
        testSites++;
        continue;
      }
      out.push({ input, observationInput: input, observation: o, entity, project: o.project as string, evidence: obsEvidence(input, o), through: null });
    }
  }
  // Package-routed: consumer call sites to package entities whose source reaches an observation of this kind.
  const byRole = new Map<Input, Map<string, Rec[]>>();
  const roleIndex = (producer: Input) => {
    let m = byRole.get(producer);
    if (!m) {
      m = new Map();
      for (const o of producer.observations(kind)) {
        const e = o[role] as string | null | undefined;
        if (!e || producer.testProjects.has(o.project as string)) continue;
        const list = m.get(e) ?? [];
        list.push(o);
        m.set(e, list);
      }
      byRole.set(producer, m);
    }
    return m;
  };
  let testCallSites = 0;
  for (const consumer of ctx.inputs) {
    const groups = new Map<string, Rec[]>();
    for (const r of consumer.set.relations) {
      if (!isInvocation(r) || !/^(?:dotnet|ts):pkg:/.test(r.to as string)) continue;
      const key = `${r.from}\u0000${r.to}`;
      const list = groups.get(key) ?? [];
      list.push(r);
      groups.set(key, list);
    }
    for (const [key, rels] of [...groups].sort(([a], [b]) => compareOrdinal(a, b))) {
      const [from, to] = key.split('\u0000');
      const er = ctx.resolver.entity(consumer, to);
      if (!er || !er.sourceEntity) continue;
      const index = roleIndex(er.producer.input);
      if (index.size === 0) continue;
      const reached = reach(er.producer.input, er.sourceEntity);
      const found = [...reached].flatMap((e) => index.get(e) ?? []).sort((a, b) => compareOrdinal(a.id, b.id));
      if (found.length === 0) continue;
      if (consumer.isTestEntity(from)) {
        testCallSites++;
        continue;
      }
      const project = consumer.contextProject.get(rels[0].context as string) ?? consumer.projectOf(from) ?? '';
      const callEvidence = uniqSorted(rels.flatMap((r) => (r.evidence as string[]).map((e) => pref(consumer.name, e))));
      for (const o of found) {
        out.push({
          input: consumer,
          observationInput: er.producer.input,
          observation: o,
          entity: from,
          project,
          evidence: uniqSorted([...callEvidence, ...obsEvidence(er.producer.input, o)]),
          through: er,
        });
      }
    }
  }
  if (testSites) notes.push({ code: `test-${kind}`, message: `${testSites} ${kind} observations in test projects are not linked across repositories.`, scope: 'system', state: 'partial' });
  if (testCallSites) notes.push({ code: `test-package-${kind}`, message: `${testCallSites} package call sites in test projects reach a ${kind} and are not linked across repositories.`, scope: 'system', state: 'partial' });
  return out;
}

function siteFrom(s: Site, kind: string): Rec {
  const from: Rec = {
    id: '',
    input: s.input.name,
    observation: pref(s.observationInput.name, s.observation.id),
    kind,
    project: s.project,
    entity: s.entity ? pref(s.input.name, s.entity) : null,
  };
  if (s.argument) from.argument = { observation: s.argument.observation, value: s.argument.value, valueSource: s.argument.valueSource };
  if (s.through) {
    from.through = {
      package: s.through.link.package,
      packageEntity: (s.through.link.from as Rec).entity,
      sourceEntity: pref(s.through.producer.input.name, s.through.sourceEntity!),
      packageLink: s.through.link.id,
      observationInput: s.observationInput.name,
      observationProject: s.observation.project,
      versionMatch: s.through.versionMatch,
    };
  }
  delete (from as Partial<Rec>).id;
  return from;
}

// ---------------------------------------------------------------------------------------------------------------
// HTTP

interface Endpoint {
  input: Input;
  obs: Rec;
  method: string | null;
  segments: string[];
}

function segments(route: string): string[] {
  return route.split('/').filter((s) => s.length > 0);
}

/** Score of a call route against an endpoint route; null when they cannot match. */
export function routeScore(call: string[], endpoint: string[]): { literal: number; guessed: number } | null {
  let literal = 0;
  let guessed = 0;
  for (let i = 0; i < endpoint.length; i++) {
    const e = endpoint[i];
    if (e === '{**}') return i <= call.length ? { literal, guessed } : null;
    const c = call[i];
    if (c === undefined) return e === '{?}' && endpoint.slice(i).every((x) => x === '{?}' || x === '{**}') ? { literal, guessed } : null;
    const eParam = e.startsWith('{');
    const cParam = c.startsWith('{');
    if (eParam) continue;
    if (cParam) {
      guessed++;
      continue;
    }
    if (c !== e) return null;
    literal++;
  }
  return call.length === endpoint.length ? { literal, guessed } : null;
}

function basePaths(ba: Rec | null | undefined): string[] {
  if (!ba) return [];
  const values = [ba.value, ...(((ba.values as Rec[] | undefined) ?? []).map((v) => v.value))].filter((v): v is string => typeof v === 'string');
  const paths = new Set<string>();
  for (const v of values) {
    try {
      const p = new URL(v).pathname.replace(/\/+$/, '').toLowerCase();
      if (p) paths.add(p);
    } catch {
      if (v.startsWith('/')) paths.add(v.replace(/\/+$/, '').toLowerCase());
    }
  }
  return [...paths].sort(compareOrdinal);
}

function baseValues(ba: Rec | null | undefined): string[] {
  if (!ba) return [];
  return [ba.value, ...(((ba.values as Rec[] | undefined) ?? []).map((v) => v.value))].filter((v): v is string => typeof v === 'string');
}

export function linkHttp(ctx: LinkContext): LinkerResult {
  const notes: LinkerResult['notes'] = [];
  const links: Rec[] = [];
  const endpoints = new Map<Input, Endpoint[]>();
  for (const input of ctx.inputs) {
    endpoints.set(
      input,
      input
        .observations('http.endpoint')
        .filter((o) => typeof o.canonicalRoute === 'string' && !input.testProjects.has(o.project as string))
        .map((o) => ({ input, obs: o, method: typeof o.method === 'string' && o.method !== 'ANY' ? (o.method as string).toUpperCase() : null, segments: segments(o.canonicalRoute as string) })),
    );
  }
  let skippedNoBase = 0;
  let unmatchedNoRoute = 0;
  for (const s of sites(ctx, 'http.call', notes).flatMap((x) => withArguments(x, ['route', 'urlTemplate']))) {
    const o = s.observation;
    const route = s.argument?.value ? canonicalRoute(s.argument.value) : (o.canonicalRoute as string | null | undefined);
    if (typeof route !== 'string') continue;
    const ba = o.baseAddress as Rec | null | undefined;
    // Which inputs can answer: routes in system.yml from the input that configures the base address.
    let targets: Input[] = [];
    let routeRes: Resolution = 'exact';
    let baseInfo: Record<string, unknown>;
    const reasons: string[] = [];
    const fromRoutes = ctx.config.routes.filter((r) => r.from === s.input.name);
    if (s.through) {
      // Base address configured by the consumer for the package's client: any route declared from the consumer.
      const keys = uniqSorted(fromRoutes.map((r) => r.baseUrl));
      targets = uniqSorted(fromRoutes.map((r) => r.to)).map((n) => ctx.byName.get(n)!);
      baseInfo = { source: 'system.yml', keys, keysInConfiguration: keys.filter((k) => s.input.configKeys.has(k)), binding: 'unknown' };
      if (targets.length > 1) {
        routeRes = 'candidate';
        reasons.push(`the package client's configuration key is not recorded; routes from ${s.input.name} lead to ${targets.map((t) => t.name).join(', ')}`);
      }
    } else if (ba) {
      const key = typeof ba.key === 'string' ? ba.key : null;
      const values = baseValues(ba);
      const matching = fromRoutes.filter((r) => r.baseUrl === key || values.includes(r.baseUrl));
      targets = uniqSorted(matching.map((r) => r.to)).map((n) => ctx.byName.get(n)!);
      baseInfo = { source: matching.length ? 'system.yml' : 'none', key, nameSource: ba.nameSource ?? null };
      if (targets.length > 1) routeRes = 'candidate';
    } else {
      skippedNoBase++;
      continue;
    }
    let declared = targets.length > 0;
    if (!declared) {
      targets = ctx.inputs.filter((i) => i !== s.input);
      routeRes = 'candidate';
      reasons.push(`no route in system.yml for ${s.through ? s.input.name : `base address ${String(ba?.key ?? 'unknown')}`}; matched by method and route only`);
    }
    const callRoutes = [segments(route), ...basePaths(ba).map((b) => segments(b + route))];
    const method = typeof o.method === 'string' ? (o.method as string).toUpperCase() : null;
    let best: { ep: Endpoint; literal: number; guessed: number }[] = [];
    for (const t of targets) {
      if (t === s.input) continue;
      for (const ep of endpoints.get(t) ?? []) {
        if (method && ep.method && method !== ep.method) continue;
        for (const cr of callRoutes) {
          const score = routeScore(cr, ep.segments);
          if (!score) continue;
          const better = !best.length || score.literal > best[0].literal || (score.literal === best[0].literal && score.guessed < best[0].guessed);
          const tie = best.length && score.literal === best[0].literal && score.guessed === best[0].guessed;
          if (better) best = [{ ep, ...score }];
          else if (tie && !best.some((b) => b.ep === ep)) best.push({ ep, ...score });
        }
      }
    }
    const from = siteFrom(s, 'http.call');
    if (!best.length) {
      if (!declared) {
        unmatchedNoRoute++;
        continue;
      }
      links.push({
        id: recordId('lnk', { kind: 'configured_route', from: from.observation, entity: from.entity, to: null, argument: s.argument?.observation }),
        kind: 'configured_route',
        via: 'http',
        scope: 'system',
        from,
        to: null,
        resolution: 'unresolved',
        reason: `no endpoint of ${targets.map((t) => t.name).join(', ')} matches ${method ?? 'any method'} ${route}`,
        match: { method, route, baseAddress: baseInfo },
        evidence: s.evidence,
      });
      continue;
    }
    const matchRes: Resolution = best.length > 1 ? 'ambiguous' : best[0].guessed > 0 ? 'candidate' : 'exact';
    if (best[0].guessed > 0) reasons.push('a parameter of the call matches a literal segment of the endpoint');
    for (const b of best) {
      const ep = b.ep;
      const to = { input: ep.input.name, observation: pref(ep.input.name, ep.obs.id), kind: 'http.endpoint', project: ep.obs.project, entity: typeof ep.obs.handler === 'string' ? pref(ep.input.name, ep.obs.handler as string) : null };
      // A route substituted from the call site replaces the template's own (weaker) resolution.
      const callRes = s.argument?.value ? 'exact' : part(o.resolution);
      const argumentRes: Resolution | null = s.argument ? (s.argument.value ? 'exact' : 'candidate') : null;
      const resolution = weakest(callRes, part(ep.obs.resolution), routeRes, s.through?.resolution, matchRes, argumentRes);
      const linkReasons = [...reasons];
      if (s.argument && !s.argument.value) linkReasons.push(`the route is a parameter and its call-site value is not known${s.argument.reason ? `: ${s.argument.reason}` : ''}`);
      if (part(o.resolution) !== 'exact' && !s.argument?.value) linkReasons.push(`the call is ${o.resolution} in ${s.observationInput.name}${o.reason ? `: ${o.reason}` : ''}`);
      if (part(ep.obs.resolution) !== 'exact') linkReasons.push(`the endpoint is ${ep.obs.resolution} in ${ep.input.name}${ep.obs.reason ? `: ${ep.obs.reason}` : ep.obs['ext.dotnet.style'] ? ` (${ep.obs['ext.dotnet.style']})` : ''}`);
      if (s.through?.link.reason) linkReasons.push(`package: ${s.through.link.reason}`);
      links.push({
        id: recordId('lnk', { kind: 'configured_route', from: from.observation, entity: from.entity, to: to.observation, argument: s.argument?.observation }),
        kind: 'configured_route',
        via: 'http',
        scope: 'system',
        from,
        to,
        resolution,
        ...(linkReasons.length && resolution !== 'exact' ? { reason: linkReasons.join('; ') } : {}),
        match: { method, route, endpointRoute: ep.obs.canonicalRoute, baseAddress: baseInfo, targets: targets.map((t) => t.name).sort(compareOrdinal) },
        evidence: uniqSorted([...s.evidence, ...obsEvidence(ep.input, ep.obs)]),
      });
    }
  }
  if (skippedNoBase) notes.push({ code: 'http-call-without-base-address', message: `${skippedNoBase} http.call observations have no base address and are not reached through a package: treated as calls inside their repository.`, scope: 'system', state: 'unknown' });
  if (unmatchedNoRoute) notes.push({ code: 'http-call-unmatched', message: `${unmatchedNoRoute} http.call observations with a base address have no route in system.yml and match no endpoint of another input; their target may be outside the system.`, scope: 'system', state: 'unknown' });
  return { links, notes };
}

// ---------------------------------------------------------------------------------------------------------------
// Messaging

function destinationNames(o: Rec): string[] {
  const d = o.destination as Rec | null | undefined;
  if (!d) return [];
  const names: string[] = [];
  if (typeof d.name === 'string' && d.nameSource !== 'unknown') names.push(d.name);
  for (const a of (d.alternatives as Rec[] | undefined) ?? []) if (typeof a.name === 'string') names.push(a.name);
  return uniqSorted(names);
}

function transports(o: Rec): string[] {
  const list = typeof o.transport === 'string' ? [o.transport] : ((o.transports as string[] | undefined) ?? []);
  return uniqSorted(list.filter((t) => t !== 'unknown'));
}

function contractName(o: Rec): string | null {
  const c = o.contract as Rec | null | undefined;
  return (c && typeof c.fullName === 'string' ? c.fullName : null) ?? null;
}

/** Destination names of a site: the call-site value when the destination is a substituted parameter. */
function siteDestinations(s: Site): string[] {
  if (s.argument?.value) return [s.argument.value];
  return destinationNames(s.observation);
}

interface MessageGroup {
  site: Site;
  /** further observations of the same logical endpoint (same entity, contract and destination) */
  also: string[];
}

function groupSites(list: Site[], role: (s: Site) => string | null): MessageGroup[] {
  const groups = new Map<string, MessageGroup>();
  for (const s of list.slice().sort((a, b) => compareOrdinal(pref(a.observationInput.name, a.observation.id), pref(b.observationInput.name, b.observation.id)))) {
    const key = [s.input.name, role(s) ?? s.observation.id, contractName(s.observation) ?? '', siteDestinations(s).join(','), s.observation.kind].join('\u0000');
    const g = groups.get(key);
    if (g) g.also.push(pref(s.observationInput.name, s.observation.id));
    else groups.set(key, { site: s, also: [] });
  }
  return [...groups.values()];
}

export function linkMessaging(ctx: LinkContext): LinkerResult {
  const notes: LinkerResult['notes'] = [];
  const links: Rec[] = [];
  const identity = ctx.config.messaging.contractIdentity;
  const publishes = groupSites(sites(ctx, 'messaging.publish', notes).flatMap((x) => withArguments(x, ['destination.name'])), (s) => s.entity);
  const subscribeSites: Site[] = [];
  for (const input of ctx.inputs)
    for (const o of input.observations('messaging.subscribe'))
      if (!input.testProjects.has(o.project as string))
        subscribeSites.push({ input, observationInput: input, observation: o, entity: (o.handler as string | null) ?? null, project: o.project as string, evidence: obsEvidence(input, o), through: null });
  const subscribes = groupSites(subscribeSites, (s) => s.entity);
  const contractKey = (s: Site): string | null => {
    const c = s.observation.contract as Rec | null | undefined;
    if (!c) return null;
    if (identity === 'typeName') return contractName(s.observation);
    if (identity === 'entity') {
      const e = c.entity as string | undefined;
      if (!e) return null;
      if (/^(?:dotnet|ts):pkg:/.test(e)) {
        const er = ctx.resolver.entity(s.observationInput, e);
        return er?.sourceEntity ? pref(er.producer.input.name, er.sourceEntity) : null;
      }
      return pref(s.observationInput.name, e);
    }
    return null;
  };
  const internalCache = new Map<Input, Set<string>>();
  const internallyLinked = (input: Input): Set<string> => {
    let set = internalCache.get(input);
    if (!set) {
      set = new Set(input.set.links.filter((l) => l.via === 'messaging' && l.to && l.resolution !== 'unresolved').map((l) => (l.from as Rec).observation as string));
      internalCache.set(input, set);
    }
    return set;
  };
  let nearMisses = 0;
  for (const p of publishes) {
    const ps = p.site;
    const pKey = contractKey(ps);
    const pDest = siteDestinations(ps);
    const pTransport = transports(ps.observation);
    const matches: { g: MessageGroup; destRes: Resolution; transportRes: Resolution }[] = [];
    // A publish the engine already linked to a subscriber inside its own repository is consumed in the system.
    let internal = !ps.through && internallyLinked(ps.input).has(ps.observation.id);
    for (const g of subscribes) {
      const ss = g.site;
      const sDest = destinationNames(ss.observation);
      const sTransport = transports(ss.observation);
      if (identity === 'destination') {
        if (!pDest.length || !sDest.length || !pDest.some((d) => sDest.includes(d))) continue;
      } else {
        const sKey = contractKey(ss);
        if (!pKey || !sKey || pKey !== sKey) continue;
      }
      // Inside one input the engine owns the link; a subscriber of the same contract there means the message is
      // consumed inside the system, whatever this linker would make of the destination.
      if (ss.input === ps.input) {
        internal = true;
        continue;
      }
      if (pTransport.length && sTransport.length && !pTransport.some((t) => sTransport.includes(t))) {
        nearMisses++;
        continue;
      }
      if (pDest.length && sDest.length && !pDest.some((d) => sDest.includes(d))) {
        nearMisses++;
        continue;
      }
      const destRes: Resolution = pDest.length && sDest.length ? 'exact' : 'candidate';
      const transportRes: Resolution = pTransport.length && sTransport.length ? 'exact' : 'candidate';
      matches.push({ g, destRes, transportRes });
    }
    const from = siteFrom(ps, 'messaging.publish');
    if (p.also.length) from.alsoObservations = p.also;
    const contract = contractName(ps.observation);
    for (const m of matches) {
      const ss = m.g.site;
      const to: Rec = { id: '', input: ss.input.name, observation: pref(ss.input.name, ss.observation.id), kind: 'messaging.subscribe', project: ss.project, entity: ss.entity ? pref(ss.input.name, ss.entity) : null };
      delete (to as Partial<Rec>).id;
      if (m.g.also.length) to.alsoObservations = m.g.also;
      const resolution = weakest(part(ps.observation.resolution), part(ss.observation.resolution), m.destRes, m.transportRes, ps.through?.resolution);
      const reasons: string[] = [];
      if (m.destRes !== 'exact') reasons.push('the destination is known on one side only');
      if (m.transportRes !== 'exact') reasons.push('the transport is known on one side only');
      for (const [side, o] of [['publisher', ps.observation], ['subscriber', ss.observation]] as const) if (part(o.resolution) !== 'exact') reasons.push(`the ${side} is ${o.resolution}${o.reason ? `: ${o.reason}` : ''}`);
      if (ps.through?.link.reason) reasons.push(`package: ${ps.through.link.reason}`);
      links.push({
        id: recordId('lnk', { kind: 'consumes_contract', via: 'messaging', from: from.observation, entity: from.entity, to: to.observation, argument: ps.argument?.observation }),
        kind: 'consumes_contract',
        via: 'messaging',
        scope: 'system',
        from,
        to,
        resolution,
        ...(reasons.length ? { reason: reasons.join('; ') } : {}),
        match: { contractIdentity: identity, contract, destination: { kind: (ps.observation.destination as Rec | null)?.kind ?? null, names: pDest.filter((d) => destinationNames(ss.observation).includes(d)) }, transports: pTransport.filter((t) => transports(ss.observation).includes(t)) },
        evidence: uniqSorted([...ps.evidence, ...ss.evidence]),
      });
    }
    if (!matches.length && !internal && !pTransport.includes('in-memory')) {
      const d = ps.observation.destination as Rec | null | undefined;
      const where = d && pDest.length ? `${d.kind} ${pDest.join(' / ')}` : 'an unknown destination';
      links.push({
        id: recordId('lnk', { kind: 'consumes_contract', via: 'messaging', from: from.observation, entity: from.entity, to: null, argument: ps.argument?.observation }),
        kind: 'consumes_contract',
        via: 'messaging',
        scope: 'system',
        from,
        to: null,
        resolution: 'unresolved',
        reason: `no subscriber in the system for ${contract ?? 'this message'} on ${where}${pTransport.length ? ` (${pTransport.join(', ')})` : ''}; the consumer may be outside the system`,
        match: { contractIdentity: identity, contract, destination: { kind: d?.kind ?? null, names: pDest }, transports: pTransport },
        evidence: ps.evidence,
      });
    }
  }
  if (nearMisses) notes.push({ code: 'messaging-near-miss', message: `${nearMisses} publisher and subscriber pairs in different inputs share the contract but not the destination or transport; they are not linked.`, scope: 'system', state: 'unknown' });
  return { links, notes };
}

// ---------------------------------------------------------------------------------------------------------------
// Real time

/** Lower-case route of a hub, connection or subscription; null when unknown. */
function hubRoute(o: Rec): string | null {
  const r = o.canonicalRoute ?? o.route;
  return typeof r === 'string' && r.startsWith('/') ? r.toLowerCase() : null;
}

/**
 * Real-time linking (contract v1.2): a subscription belongs to the hub whose route equals its route, after its
 * connection's base address routes it to an input; `pushes_to` goes from the hub's sends to subscriptions with the same
 * method name compared ordinal and case-insensitive. A send whose method is a helper parameter takes the call-site value.
 */
export function linkRealtime(ctx: LinkContext): LinkerResult {
  const notes: LinkerResult['notes'] = [];
  const links: Rec[] = [];
  const senders = sites(ctx, 'realtime.send', notes).flatMap((x) => withArguments(x, ['method']));
  for (const input of ctx.inputs) {
    const connections = input.observations('realtime.connection');
    for (const sub of input.observations('realtime.subscribe')) {
      if (input.testProjects.has(sub.project as string)) continue;
      const method = typeof sub.method === 'string' ? sub.method : null;
      const route = hubRoute(sub);
      const reasons: string[] = [];
      // The connection the subscription is made on: same route, else the same client when the route is unknown.
      const connection =
        (route ? connections.find((c) => hubRoute(c) === route) : undefined) ??
        (typeof sub.client === 'string' ? connections.find((c) => c.client === sub.client) : undefined) ??
        (connections.length === 1 ? connections[0] : undefined);
      const fromRoutes = ctx.config.routes.filter((r) => r.from === input.name);
      const ba = connection?.baseAddress as Rec | null | undefined;
      let targets: Input[] = [];
      let routeRes: Resolution = 'exact';
      if (ba) {
        const key = typeof ba.key === 'string' ? ba.key : null;
        const values = baseValues(ba);
        targets = uniqSorted(fromRoutes.filter((r) => r.baseUrl === key || values.includes(r.baseUrl)).map((r) => r.to)).map((n) => ctx.byName.get(n)!);
        if (!targets.length) reasons.push(`no route in system.yml for the connection's base address ${String(key ?? 'unknown')}`);
      } else {
        reasons.push(connection ? 'the connection records no base address' : 'no connection of this subscription is recorded');
      }
      if (!targets.length) {
        const all = uniqSorted(fromRoutes.map((r) => r.to)).map((n) => ctx.byName.get(n)!);
        if (all.length === 1) {
          targets = all;
          reasons.push(`the only route from ${input.name} in system.yml leads to ${all[0].name}`);
        } else if (route) targets = ctx.inputs.filter((i) => i !== input);
        routeRes = 'candidate';
      }
      if (targets.length > 1) routeRes = 'candidate';
      // Hubs of the target inputs: by route; without a route, the only hub of the only target.
      let hubs: { input: Input; hub: Rec }[] = [];
      let hubRes: Resolution = 'exact';
      if (route) hubs = targets.filter((t) => t !== input).flatMap((t) => t.observations('realtime.hub').filter((h) => hubRoute(h) === route).map((hub) => ({ input: t, hub })));
      else if (targets.length === 1) {
        hubs = targets[0].observations('realtime.hub').map((hub) => ({ input: targets[0], hub }));
        hubRes = 'candidate';
        reasons.push('the client does not record the hub route');
      } else reasons.push(`the client does not record the hub route and routes from ${input.name} lead to ${targets.length} inputs`);
      if (hubs.length > 1) hubRes = 'ambiguous';
      const to: Rec = { id: '', input: input.name, observation: pref(input.name, sub.id), kind: 'realtime.subscribe', project: sub.project, entity: typeof sub.client === 'string' ? pref(input.name, sub.client as string) : null };
      delete (to as Partial<Rec>).id;
      let linked = 0;
      for (const h of hubs) {
        const hubEntity = typeof h.hub.hub === 'string' ? (h.hub.hub as string) : null;
        for (const s of senders.filter((x) => x.input === h.input)) {
          const sendHub = s.observation.hub;
          if (typeof sendHub === 'string' && sendHub !== 'unknown' && hubEntity && sendHub !== hubEntity) continue;
          const sendMethod = s.argument ? s.argument.value : typeof s.observation.method === 'string' ? (s.observation.method as string) : null;
          if (sendMethod && method && sendMethod.toLowerCase() !== method.toLowerCase()) continue;
          const methodRes: Resolution = sendMethod && method ? 'exact' : 'candidate';
          const linkReasons = [...reasons];
          if (!sendMethod) {
            if (s.argument) linkReasons.push(`the client method name is an argument whose call-site value is not known${s.argument.reason ? `: ${s.argument.reason}` : ''}`);
            else linkReasons.push(s.through ? 'the client method name is an argument of the package method at the call site and is not recorded' : 'the sender does not record the client method name');
          }
          if (part(sub.resolution) !== 'exact' && sub.reason) linkReasons.push(`subscription in ${input.name}: ${sub.reason}`);
          if (s.through?.link.reason) linkReasons.push(`package: ${s.through.link.reason}`);
          const from = siteFrom(s, 'realtime.send');
          // The send's own resolution is weak only because its method or hub is unknown; a substituted method and a
          // hub found by route stand in for those parts.
          const sendRes = s.argument?.value ? 'exact' : part(s.observation.resolution);
          const resolution = weakest(part(sub.resolution), sendRes, routeRes, hubRes, methodRes, s.through?.resolution);
          links.push({
            id: recordId('lnk', { kind: 'pushes_to', from: from.observation, entity: from.entity, to: to.observation, argument: s.argument?.observation }),
            kind: 'pushes_to',
            via: 'realtime',
            scope: 'system',
            from,
            to,
            resolution,
            ...(linkReasons.length && resolution !== 'exact' ? { reason: linkReasons.join('; ') } : {}),
            match: { method, sendMethod, hub: { input: h.input.name, observation: pref(h.input.name, h.hub.id), route: h.hub.canonicalRoute ?? h.hub.route ?? null }, connection: connection ? pref(input.name, connection.id) : null },
            evidence: uniqSorted([...s.evidence, ...obsEvidence(input, sub), ...obsEvidence(h.input, h.hub), ...(connection ? obsEvidence(input, connection) : [])]),
          });
          linked++;
        }
      }
      if (!linked) {
        links.push({
          id: recordId('lnk', { kind: 'pushes_to', from: null, to: to.observation }),
          kind: 'pushes_to',
          via: 'realtime',
          scope: 'system',
          // An unresolved subscription has no known sender; the link starts at the subscription (it is the only site).
          from: { input: input.name, observation: to.observation, kind: 'realtime.subscribe', project: sub.project, entity: to.entity },
          to: null,
          resolution: 'unresolved',
          reason: hubs.length ? `no sender of ${method ?? 'this method'} found behind the hub` : reasons.length ? reasons.join('; ') : `no hub in the system serves ${route ?? 'this subscription'}`,
          match: { method, route },
          evidence: obsEvidence(input, sub),
        });
      }
    }
  }
  return { links, notes };
}

// ---------------------------------------------------------------------------------------------------------------
// In-process dispatch across inputs (contract v1.2, C8): a send in one input whose request has a handler in another
// input (a handler shipped in a package, or a request type shared through one). Sends and handlers inside one input
// are the engine's links.

function pattern(o: Rec): string {
  if (typeof o.pattern === 'string') return o.pattern;
  return o.mechanism === 'ngrx' ? 'notification' : 'request';
}

/** Evidence of a dispatch side: its `site`, else every evidence (rule 6). */
function siteEvidence(input: Input, o: Rec): string[] {
  return typeof o.site === 'string' ? [pref(input.name, o.site)] : obsEvidence(input, o);
}

export function linkDispatch(ctx: LinkContext): LinkerResult {
  const notes: LinkerResult['notes'] = [];
  const links: Rec[] = [];
  // A request type is identified across inputs by its source entity: package symbols resolve to their producer.
  const key = (input: Input, entity: unknown): string | null => {
    if (typeof entity !== 'string') return null;
    if (/^(?:dotnet|ts):pkg:/.test(entity)) {
      const er = ctx.resolver.entity(input, entity);
      return er?.sourceEntity ? pref(er.producer.input.name, er.sourceEntity) : pref(input.name, entity);
    }
    return pref(input.name, entity);
  };
  const ancestors = (input: Input, entity: string): Set<string> => {
    const out = new Set<string>();
    let frontier = [entity];
    for (let d = 0; d < 6 && frontier.length; d++) {
      const next: string[] = [];
      for (const e of frontier)
        for (const r of input.relationsFrom.get(e) ?? [])
          if (r.kind === 'inherits' || r.kind === 'implements') {
            const k = key(input, r.to);
            if (k && !out.has(k)) {
              out.add(k);
              next.push(r.to as string);
            }
          }
      frontier = next;
    }
    return out;
  };
  const handlers: { input: Input; o: Rec; request: string; args: string[] | null; ancestors: Set<string> }[] = [];
  for (const input of ctx.inputs)
    for (const o of input.observations('inprocess.handler')) {
      if (input.testProjects.has(o.project as string)) continue;
      const request = key(input, o.request);
      if (!request) continue;
      const args = Array.isArray(o.requestTypeArguments) ? (o.requestTypeArguments as string[]).map((a) => key(input, a) ?? a) : null;
      handlers.push({ input, o, request, args, ancestors: typeof o.request === 'string' ? ancestors(input, o.request) : new Set() });
    }
  for (const s of sites(ctx, 'inprocess.send', notes)) {
    const o = s.observation;
    const request = key(s.observationInput, o.request);
    if (!request) continue;
    const sendRes: Resolution = o.resolution === 'candidate' ? 'candidate' : o.resolution === 'unresolved' ? 'unresolved' : 'exact';
    const sendArgs = Array.isArray(o.requestTypeArguments) ? (o.requestTypeArguments as string[]).map((a) => key(s.observationInput, a) ?? a) : null;
    const p = pattern(o);
    const matching = handlers.filter((h) => {
      if (h.o.mechanism !== o.mechanism || pattern(h.o) !== p) return false;
      const sameRequest = h.request === request;
      if (!sameRequest && !(sendRes === 'candidate' && h.ancestors.has(request))) return false;
      if (sendArgs && h.args && sendArgs.join('\u0000') !== h.args.join('\u0000')) return false;
      return true;
    });
    const external = matching.filter((h) => h.input !== s.input);
    const requestInput = request.slice(0, request.indexOf('/'));
    const from = siteFrom(s, 'inprocess.send');
    const fromEvidence = s.through ? s.evidence : siteEvidence(s.observationInput, o);
    if (!external.length) {
      // Unresolved only when the request type comes from another input (a cross-repository contract) and no input
      // handles it; inside one repository the engine reports it.
      if (!matching.length && requestInput !== s.input.name)
        links.push({
          id: recordId('lnk', { kind: 'dispatches_to', from: from.observation, entity: from.entity, to: null }),
          kind: 'dispatches_to',
          via: 'inprocess',
          scope: 'system',
          from,
          to: null,
          resolution: 'unresolved',
          reason: `no handler in the system for ${request} (${o.mechanism}, ${p})`,
          match: { mechanism: o.mechanism, pattern: p, request },
          evidence: fromEvidence,
        });
      continue;
    }
    for (const h of external.sort((a, b) => compareOrdinal(pref(a.input.name, a.o.id), pref(b.input.name, b.o.id)))) {
      const reasons: string[] = [];
      let res: Resolution;
      if (sendRes === 'candidate') {
        res = 'candidate';
        reasons.push('the dispatched argument is not a concrete type; the runtime type decides');
      } else if (p === 'notification') res = sendRes;
      else if (matching.length > 1) {
        res = 'ambiguous';
        reasons.push(`${matching.length} handlers in the system handle ${request}; the container picks one`);
      } else res = sendRes;
      if ((sendArgs === null) !== (h.args === null) && (sendArgs || h.args)) {
        res = weakest(res, 'candidate');
        reasons.push('the request is generic and only one side records its type arguments');
      }
      if (s.through?.link.reason) reasons.push(`package: ${s.through.link.reason}`);
      res = weakest(res, s.through?.resolution, part(h.o.resolution));
      const to = { input: h.input.name, observation: pref(h.input.name, h.o.id), kind: 'inprocess.handler', project: h.o.project, entity: typeof h.o.handler === 'string' ? pref(h.input.name, h.o.handler as string) : null };
      links.push({
        id: recordId('lnk', { kind: 'dispatches_to', from: from.observation, entity: from.entity, to: to.observation }),
        kind: 'dispatches_to',
        via: 'inprocess',
        scope: 'system',
        from,
        to,
        resolution: res,
        ...(reasons.length && res !== 'exact' ? { reason: reasons.join('; ') } : {}),
        match: { mechanism: o.mechanism, pattern: p, request, handlerMethod: typeof h.o.handlerMethod === 'string' ? pref(h.input.name, h.o.handlerMethod as string) : null },
        evidence: uniqSorted([...fromEvidence, ...siteEvidence(h.input, h.o)]),
      });
    }
  }
  return { links, notes };
}
