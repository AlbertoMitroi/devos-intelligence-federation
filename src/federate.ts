// The federation pipeline (PLAN "Pipeline"): verify and inventory inputs, resolve packages, link across inputs,
// build traces, then write the system generation (records, index, context packs, manifest last).
import { existsSync } from 'node:fs';
import { compareOrdinal } from './util/canonical.ts';
import { Input, verifyInput, type InputVerification } from './input.ts';
import { linkDispatch, linkHttp, linkMessaging, linkRealtime, type LinkContext, type LinkerResult } from './links.ts';
import { PackageResolver } from './packages.ts';
import type { Rec } from './records.ts';
import type { SystemConfig } from './system.ts';
import { buildTraces } from './traces.ts';

export interface InputState {
  name: string;
  path: string | null;
  oci: string | null;
  verification: InputVerification;
  input: Input | null;
  /** The loaded generation, also when verification excluded it (its manifest is still inventoried). */
  loaded?: Input | null;
}

export interface Federation {
  config: SystemConfig;
  states: InputState[];
  inputs: Input[];
  packages: Rec[];
  packageLinks: Rec[];
  links: Rec[];
  traces: Rec[];
  notes: LinkerResult['notes'];
}

export function loadInputs(config: SystemConfig): InputState[] {
  return config.generations.map((g) => {
    if (!g.path) return { name: g.name, path: null, oci: g.oci, verification: { ok: false, errors: [`OCI input '${g.oci}' is not read by federation: pull it (ORAS) and pass --input ${g.name}=<directory>`], references: [], notes: [] }, input: null };
    if (!existsSync(g.path)) return { name: g.name, path: g.path, oci: null, verification: { ok: false, errors: [`generation directory not found: ${g.path}`], references: [], notes: [] }, input: null };
    let input: Input | null = null;
    try {
      input = new Input(g.name, g.path);
    } catch (e) {
      return { name: g.name, path: g.path, oci: null, verification: { ok: false, errors: [`generation could not be read: ${(e as Error).message}`], references: [], notes: [] }, input: null };
    }
    const verification = verifyInput(g.path, input.set);
    return { name: g.name, path: g.path, oci: null, verification, input: verification.ok ? input : null, loaded: input };
  });
}

export function federate(config: SystemConfig, states: InputState[]): Federation {
  const inputs = states.filter((s) => s.input).map((s) => s.input!);
  const byName = new Map(inputs.map((i) => [i.name, i]));
  // Routes to or from an excluded input are dropped; the system generation reports the exclusion.
  const routes = config.routes.filter((r) => byName.has(r.from) && byName.has(r.to));
  const ctx: LinkContext = { config: { ...config, routes }, inputs, byName, resolver: new PackageResolver(inputs) };
  const results = [linkHttp(ctx), linkMessaging(ctx), linkRealtime(ctx), linkDispatch(ctx)];
  // Every package entity used by an input whose producer is in the system gets its implemented_by_package link,
  // also when no call through it reaches an observation.
  for (const input of inputs)
    for (const r of input.set.relations)
      if (/^(?:dotnet|ts):pkg:/.test(r.to as string) && !input.isTestEntity(r.from as string)) ctx.resolver.entity(input, r.to as string);
  const links = results.flatMap((r) => r.links).sort((a, b) => compareOrdinal(a.id, b.id));
  const packageLinks = ctx.resolver.links().sort((a, b) => compareOrdinal(a.id, b.id));
  const packages = ctx.resolver.records().sort((a, b) => compareOrdinal(a.id, b.id));
  for (const p of packages) (p.entities as { missing: string[] }).missing.sort(compareOrdinal);
  const notes = results.flatMap((r) => r.notes);
  for (const [consumer, set] of [...ctx.resolver.external].sort(([a], [b]) => compareOrdinal(a, b)))
    notes.push({ code: 'packages-without-producer', message: `${set.size} package versions used by ${consumer} are produced by no input of the system (treated as third-party).`, scope: consumer, state: 'unknown' });
  const traces = buildTraces(inputs, byName, links);
  return { config, states, inputs, packages, packageLinks, links, traces, notes };
}
