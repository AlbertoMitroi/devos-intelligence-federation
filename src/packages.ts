// Package to source (PLAN pipeline 3): a package symbol used by one input is resolved to the source entity of the
// input whose project produces that package. Records: graph/packages.ndjson (one per consumed package and version)
// and implemented_by_package links (one per package entity used).
import { compareOrdinal, recordId } from './util/canonical.ts';
import type { Input } from './input.ts';
import type { Rec } from './records.ts';

export type Resolution = 'exact' | 'ambiguous' | 'candidate' | 'unresolved';
export type VersionMatch = 'exact' | 'different' | 'unknown';

const ORDER: Resolution[] = ['exact', 'ambiguous', 'candidate', 'unresolved'];
/** A link takes the weakest resolution of its parts (contract v1). */
export function weakest(...parts: (Resolution | null | undefined)[]): Resolution {
  let worst = 0;
  for (const p of parts) if (p) worst = Math.max(worst, ORDER.indexOf(p));
  return ORDER[worst];
}

export function pref(input: string, id: string): string {
  return `${input}/${id}`;
}

export interface PackageRef {
  ecosystem: 'nuget' | 'npm';
  packageId: string;
  version: string;
  assembly: string | null;
  /** documentation comment id (.NET) or `{modulePath}#{symbolPath}` (TypeScript) */
  symbol: string;
}

export function parsePackageEntity(id: string): PackageRef | null {
  let m = /^dotnet:pkg:([^@:]+)@([^:]+):([^:]+):(.+)$/.exec(id);
  if (m) return { ecosystem: 'nuget', packageId: m[1], version: m[2], assembly: m[3], symbol: m[4] };
  m = /^ts:pkg:((?:@[^/@:]+\/)?[^@:]+)@([^:]+):(.+)$/.exec(id);
  if (m) return { ecosystem: 'npm', packageId: m[1], version: m[2], assembly: null, symbol: m[3] };
  return null;
}

export interface Producer {
  input: Input;
  project: Rec;
  method: 'packageId' | 'assemblyName' | 'npmName';
}

export interface PackageResolution {
  record: Rec;
  producer: Producer | null;
  resolution: Resolution;
  versionMatch: VersionMatch;
}

export interface EntityResolution {
  packageEntity: string;
  consumer: Input;
  producer: Producer;
  /** source entity id inside the producer input (not prefixed), or null when the symbol is missing at that commit */
  sourceEntity: string | null;
  resolution: Resolution;
  versionMatch: VersionMatch;
  link: Rec;
}

export class PackageResolver {
  private readonly inputs: Input[];
  private readonly packages = new Map<string, PackageResolution>();
  private readonly entities = new Map<string, EntityResolution | null>();
  /** Packages consumed but produced by no input: treated as third-party, counted in a diagnostic. */
  readonly external = new Map<string, Set<string>>();

  constructor(inputs: Input[]) {
    this.inputs = inputs;
  }

  private producersOf(consumer: Input, ref: PackageRef): { producers: Producer[]; method: Producer['method'] | null } {
    const others = this.inputs.filter((i) => i !== consumer);
    const projects = (i: Input) => [...i.projects.values()].sort((a, b) => compareOrdinal(a.path as string, b.path as string));
    if (ref.ecosystem === 'npm') {
      const byName = others.flatMap((i) => projects(i).filter((p) => p.npmName === ref.packageId).map((p) => ({ input: i, project: p, method: 'npmName' as const })));
      return { producers: byName, method: byName.length ? 'npmName' : null };
    }
    const byId = others.flatMap((i) => projects(i).filter((p) => p.packageId === ref.packageId).map((p) => ({ input: i, project: p, method: 'packageId' as const })));
    if (byId.length) return { producers: byId, method: 'packageId' };
    // Fallback when the producer's generation does not carry the evaluated PackageId (contract v1.1 field missing):
    // the project whose assembly name is the package id and the package's assembly, and which is not a test project.
    const byAssembly = others.flatMap((i) =>
      projects(i)
        .filter((p) => p.packageId === null || p.packageId === undefined)
        .filter((p) => p.assemblyName === ref.packageId && p.assemblyName === ref.assembly && p.isPackable !== false && !i.testProjects.has(p.path as string))
        .map((p) => ({ input: i, project: p, method: 'assemblyName' as const })),
    );
    return { producers: byAssembly, method: byAssembly.length ? 'assemblyName' : null };
  }

  /** Resolution of one consumed package version (cached). */
  package(consumer: Input, ref: PackageRef): PackageResolution | null {
    const key = `${consumer.name}\u0000${ref.ecosystem}\u0000${ref.packageId}\u0000${ref.version}`;
    if (this.packages.has(key)) return this.packages.get(key)!;
    const { producers } = this.producersOf(consumer, ref);
    if (producers.length === 0) {
      const set = this.external.get(consumer.name) ?? new Set<string>();
      set.add(`${ref.packageId}@${ref.version}`);
      this.external.set(consumer.name, set);
      this.packages.set(key, null as unknown as PackageResolution);
      return null;
    }
    const producer = producers[0];
    const producedVersion = (ref.ecosystem === 'npm' ? producer.project.npmVersion : producer.project.packageVersion) as string | null | undefined;
    const versionMatch: VersionMatch = producedVersion ? (producedVersion === ref.version ? 'exact' : 'different') : 'unknown';
    let resolution: Resolution = producers.length > 1 ? 'ambiguous' : producer.method === 'assemblyName' ? 'candidate' : 'exact';
    const reasons: string[] = [];
    if (producers.length > 1) reasons.push(`${producers.length} projects produce ${ref.packageId}: ${producers.map((p) => `${p.input.name}:${p.project.path}`).join(', ')}`);
    if (producer.method === 'assemblyName') reasons.push(`the producing generation has no packageId for ${producer.project.path}; matched by assembly name ${ref.assembly}`);
    if (versionMatch === 'unknown') reasons.push(`the producing generation has no package version for ${producer.project.path}`);
    if (versionMatch === 'different') reasons.push(`consumed ${ref.version}, produced ${producedVersion} at commit ${String(producer.input.manifest.commit).slice(0, 12)}; symbols are resolved against that commit`);
    const consumerProjects = [...consumer.projects.values()]
      .filter((p) => ((p.packages as { id: string; version: string }[] | undefined) ?? []).some((x) => x.id === ref.packageId && x.version === ref.version))
      .map((p) => p.path as string)
      .sort(compareOrdinal);
    const record: Rec = {
      id: recordId('pkr', { consumer: consumer.name, ecosystem: ref.ecosystem, packageId: ref.packageId, version: ref.version }),
      recordType: 'packageResolution',
      ecosystem: ref.ecosystem,
      packageId: ref.packageId,
      version: ref.version,
      consumer: { input: consumer.name, projects: consumerProjects },
      producer: {
        input: producer.input.name,
        project: producer.project.path,
        method: producer.method,
        packageId: (producer.project.packageId ?? producer.project.npmName ?? null) as string | null,
        packageVersion: producedVersion ?? null,
        repository: producer.input.remoteUrl(),
        commit: producer.input.manifest.commit,
        // Generations do not record tags; the source is the analysed commit of the producing input.
        tag: null,
      },
      resolution,
      versionMatch,
      ...(reasons.length ? { reason: reasons.join('; ') } : {}),
      entities: { used: 0, resolved: 0, missing: [] as string[] },
    };
    const res: PackageResolution = { record, producer, resolution, versionMatch };
    this.packages.set(key, res);
    return res;
  }

  /** Resolution of one package entity used by `consumer` (cached); null when no input produces the package. */
  entity(consumer: Input, packageEntity: string): EntityResolution | null {
    const key = `${consumer.name}\u0000${packageEntity}`;
    if (this.entities.has(key)) return this.entities.get(key)!;
    const ref = parsePackageEntity(packageEntity);
    const pkg = ref ? this.package(consumer, ref) : null;
    if (!ref || !pkg || !pkg.producer) {
      this.entities.set(key, null);
      return null;
    }
    const producer = pkg.producer;
    const projectPath = producer.project.path as string;
    let sourceEntity: string | null = null;
    if (ref.ecosystem === 'nuget') {
      const candidate = `dotnet:${projectPath}:${ref.symbol}`;
      if (producer.input.entities.has(candidate)) sourceEntity = candidate;
    } else {
      const [, symbolPath] = ref.symbol.split('#');
      const prefix = `ts:${projectPath}:`;
      const matches = [...producer.input.entities.keys()].filter((id) => id.startsWith(prefix) && id.endsWith(`#${symbolPath}`)).sort(compareOrdinal);
      if (matches.length === 1) sourceEntity = matches[0];
    }
    const stats = pkg.record.entities as { used: number; resolved: number; missing: string[] };
    stats.used++;
    if (sourceEntity) stats.resolved++;
    else stats.missing.push(ref.symbol);
    const resolution = sourceEntity ? pkg.resolution : 'unresolved';
    const consumerRelations = (consumer.relationsTo.get(packageEntity) ?? []).slice().sort((a, b) => compareOrdinal(a.id, b.id));
    const evidence = new Set<string>();
    if (consumerRelations.length) for (const e of consumerRelations[0].evidence as string[]) evidence.add(pref(consumer.name, e));
    if (sourceEntity) {
      const producerRelations = [...(producer.input.relationsTo.get(sourceEntity) ?? []), ...(producer.input.relationsFrom.get(sourceEntity) ?? [])].sort((a, b) => compareOrdinal(a.id, b.id));
      if (producerRelations.length) for (const e of producerRelations[0].evidence as string[]) evidence.add(pref(producer.input.name, e));
    }
    const reason = sourceEntity ? (pkg.record.reason as string | undefined) : `${ref.symbol} is not declared in ${producer.input.name}:${projectPath} at commit ${String(producer.input.manifest.commit).slice(0, 12)}`;
    const from = { input: consumer.name, observation: null, kind: 'package.entity', project: null, entity: pref(consumer.name, packageEntity) };
    const to = sourceEntity ? { input: producer.input.name, observation: null, kind: 'source.entity', project: projectPath, entity: pref(producer.input.name, sourceEntity) } : null;
    const link: Rec = {
      id: recordId('lnk', { kind: 'implemented_by_package', from: from.entity, to: to?.entity ?? null }),
      kind: 'implemented_by_package',
      via: 'package',
      scope: 'system',
      from,
      to,
      resolution,
      versionMatch: pkg.versionMatch,
      package: { ecosystem: ref.ecosystem, id: ref.packageId, version: ref.version, producedVersion: (pkg.record.producer as Rec).packageVersion ?? null, resolutionRecord: pkg.record.id },
      ...(reason ? { reason } : {}),
      evidence: [...evidence].sort(compareOrdinal),
    };
    const out: EntityResolution = { packageEntity, consumer, producer, sourceEntity, resolution, versionMatch: pkg.versionMatch, link };
    this.entities.set(key, out);
    return out;
  }

  records(): Rec[] {
    return [...this.packages.values()].filter((p) => p !== null).map((p) => p.record);
  }

  links(): Rec[] {
    return [...this.entities.values()].filter((e): e is EntityResolution => e !== null).map((e) => e.link);
  }
}
