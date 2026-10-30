// GitHub Action mode: maps INPUT_* to federate, applies fail-on, writes GITHUB_OUTPUT, emits annotations for excluded
// inputs, and hands the output back to the owner of the workspace (the action image runs as root to write it).
import { appendFileSync, chownSync, existsSync, lstatSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { federate, loadInputs } from './federate.ts';
import { writeSystemGeneration } from './generation.ts';
import { readSystem, SystemConfigError } from './system.ts';

function input(name: string, fallback = ''): string {
  return (process.env[`INPUT_${name.toUpperCase()}`] ?? '').trim() || fallback;
}

function escapeData(s: string): string {
  return s.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
}

function chownTree(path: string, uid: number, gid: number): void {
  if (!existsSync(path)) return;
  try {
    chownSync(path, uid, gid);
  } catch {
    return;
  }
  if (lstatSync(path).isDirectory()) for (const n of readdirSync(path)) chownTree(join(path, n), uid, gid);
}

export function runGitHubAction(): number {
  const workspace = process.env.GITHUB_WORKSPACE ?? process.cwd();
  const output = input('output', 'system-out');
  const failOn = input('fail-on', 'failed');
  if (!['failed', 'partial', 'never'].includes(failOn)) {
    process.stdout.write(`::error::fail-on must be failed, partial or never (got '${escapeData(failOn)}')\n`);
    return 2;
  }
  const overrides = new Map<string, string>();
  for (const line of input('inputs').split('\n').map((l) => l.trim()).filter(Boolean)) {
    const eq = line.indexOf('=');
    if (eq <= 0) throw new SystemConfigError(`inputs: expected <name>=<directory>, got '${line}'`);
    overrides.set(line.slice(0, eq).trim(), resolve(workspace, line.slice(eq + 1).trim()));
  }
  const out = resolve(workspace, output);
  const config = readSystem(resolve(workspace, input('system', 'system.yml')), overrides);
  const states = loadInputs(config);
  for (const s of states) if (!s.input) process.stdout.write(`::error title=input-excluded::${escapeData(`${s.name}: ${s.verification.errors.slice(0, 3).join('; ')}`)}\n`);
  let status = 'failed';
  if (states.some((s) => s.input)) status = writeSystemGeneration(federate(config, states), out, Date.now()).status;
  const manifest = join(out, 'manifest.json');
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, [`generation-path=${output}`, `manifest-path=${existsSync(manifest) ? `${output}/manifest.json` : ''}`, `status=${status}`].join('\n') + '\n');
  try {
    const owner = statSync(workspace);
    chownTree(out, owner.uid, owner.gid);
  } catch {
    // not fatal: the files stay readable
  }
  process.stdout.write(`system generation ${output}: ${status}\n`);
  if (status === 'failed') return 51;
  if (failOn === 'partial' && status === 'partial') return 1;
  return 0;
}
