// system.yml (PLAN, "Inputs"): the caller's description of the system. Nothing in it is guessed by the federation.
import { readFileSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { parse } from 'yaml';
import { INPUT_NAME } from './integrity.ts';

export type ContractIdentity = 'typeName' | 'entity' | 'destination';

export interface SystemRoute {
  from: string;
  /** Configuration key (or a literal value) seen in the caller's generation. */
  baseUrl: string;
  to: string;
}

export interface SystemInputRef {
  name: string;
  /** Absolute path of the generation directory, or null when the input is an OCI reference (not supported). */
  path: string | null;
  oci: string | null;
}

export interface SystemConfig {
  system: string;
  generations: SystemInputRef[];
  routes: SystemRoute[];
  messaging: { contractIdentity: ContractIdentity };
  /** The canonical form of the configuration, hashed into the manifest. */
  canonical: Record<string, unknown>;
}

export class SystemConfigError extends Error {}

/**
 * Reads system.yml. Relative paths resolve against the file's directory; `overrides` (name -> directory) replace a
 * generation's path, so the same system.yml works from CI, Docker mounts and local folders.
 */
export function readSystem(file: string, overrides: Map<string, string> = new Map()): SystemConfig {
  const raw = parse(readFileSync(file, 'utf8')) as Record<string, any>;
  const fail = (m: string): never => {
    throw new SystemConfigError(`${file}: ${m}`);
  };
  if (!raw || typeof raw !== 'object') fail('not a YAML mapping');
  const system = String(raw.system ?? '');
  if (!INPUT_NAME.test(system)) fail(`system '${system}' must match ${INPUT_NAME}`);
  if (!Array.isArray(raw.generations) || raw.generations.length === 0) fail('generations must be a non-empty list');
  const base = dirname(resolve(file));
  const names = new Set<string>();
  const generations: SystemInputRef[] = raw.generations.map((g: Record<string, unknown>, i: number) => {
    const name = String(g?.name ?? '');
    if (!INPUT_NAME.test(name)) fail(`generations[${i}].name '${name}' must match ${INPUT_NAME}`);
    if (names.has(name)) fail(`generations[${i}].name '${name}' is not unique`);
    names.add(name);
    const override = overrides.get(name);
    if (override) return { name, path: resolve(override), oci: null };
    if (typeof g.oci === 'string') return { name, path: null, oci: g.oci };
    if (typeof g.path !== 'string') fail(`generations[${i}] needs path or oci`);
    const p = g.path as string;
    return { name, path: isAbsolute(p) ? p : resolve(base, p), oci: null };
  });
  for (const name of overrides.keys()) if (!names.has(name)) fail(`--input ${name}: no generation with that name`);
  const routes: SystemRoute[] = (raw.routes ?? []).map((r: Record<string, unknown>, i: number) => {
    const from = String(r?.from ?? '');
    const to = String(r?.to ?? '');
    const baseUrl = String(r?.baseUrl ?? '');
    if (!names.has(from)) fail(`routes[${i}].from '${from}' is not a generation`);
    if (!names.has(to)) fail(`routes[${i}].to '${to}' is not a generation`);
    if (!baseUrl) fail(`routes[${i}].baseUrl is empty`);
    return { from, baseUrl, to };
  });
  const identity = String(raw.messaging?.contractIdentity ?? 'typeName');
  if (!['typeName', 'entity', 'destination'].includes(identity)) fail(`messaging.contractIdentity '${identity}' must be typeName, entity or destination`);
  // Paths are left out of the canonical form: where a generation sits does not change the system.
  const canonical = {
    system,
    generations: raw.generations.map((g: Record<string, unknown>) => ({ name: g.name, oci: g.oci ?? null })),
    routes: routes.map((r) => ({ from: r.from, baseUrl: r.baseUrl, to: r.to })),
    messaging: { contractIdentity: identity },
  };
  return { system, generations, routes, messaging: { contractIdentity: identity as ContractIdentity }, canonical };
}
