#!/usr/bin/env node
// intelligence-federation CLI: federate, verify, evaluate, dump-index, version.
import { writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { evaluate, renderReport } from './evaluate.ts';
import { federate, loadInputs } from './federate.ts';
import { runGitHubAction } from './gha.ts';
import { ENGINE, indexDump, verifySystemGeneration, writeSystemGeneration } from './generation.ts';
import { readSystem, SystemConfigError } from './system.ts';

const USAGE = `intelligence-federation ${ENGINE.version}

Usage:
  federate --system <system.yml> --out <dir> [--input <name>=<generation dir>]...
  verify <system generation> [--input <name>=<generation dir>]...
  evaluate <system generation> --expected <expected-links.yml> [--report <file.md>] [--json <file.json>]
  dump-index <system generation>
  list-inputs --system <system.yml>   (one line per generation: <name> TAB <oci reference or ->)
  gha                      (GitHub Action mode: INPUT_SYSTEM, INPUT_INPUTS, INPUT_OUTPUT, INPUT_FAIL-ON)
  version [--json]

Exit codes: 0 ok (federate: complete or partial), 2 usage, 50 verification failed, 51 no input usable.`;

function parseArgs(argv: string[]): { positional: string[]; options: Map<string, string[]>; flags: Set<string> } {
  const positional: string[] = [];
  const options = new Map<string, string[]>();
  const flags = new Set<string>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json' && (argv[i + 1] === undefined || argv[i + 1].startsWith('--'))) flags.add('json');
    else if (a.startsWith('--')) {
      const v = argv[++i];
      if (v === undefined) throw new SystemConfigError(`${a} needs a value`);
      options.set(a.slice(2), [...(options.get(a.slice(2)) ?? []), v]);
    } else positional.push(a);
  }
  return { positional, options, flags };
}

function inputOverrides(options: Map<string, string[]>): Map<string, string> {
  const m = new Map<string, string>();
  for (const v of options.get('input') ?? []) {
    const eq = v.indexOf('=');
    if (eq <= 0) throw new SystemConfigError(`--input ${v}: expected <name>=<directory>`);
    m.set(v.slice(0, eq), v.slice(eq + 1));
  }
  return m;
}

function one(options: Map<string, string[]>, key: string): string | undefined {
  return options.get(key)?.at(-1);
}

function main(argv: string[]): number {
  const [command, ...rest] = argv;
  if (!command || command === '--help' || command === 'help') {
    process.stdout.write(USAGE + '\n');
    return command ? 0 : 2;
  }
  const { positional, options, flags } = parseArgs(rest);
  switch (command) {
    case 'version': {
      const db = new DatabaseSync(':memory:');
      const sqlite = String((db.prepare('select sqlite_version() as v').get() as { v: string }).v);
      let fts5 = true;
      try {
        db.exec('create virtual table t using fts5(x)');
      } catch {
        fts5 = false;
      }
      db.close();
      const info = { engine: ENGINE, node: process.version, sqlite, fts5 };
      process.stdout.write(flags.has('json') ? JSON.stringify(info) + '\n' : `${ENGINE.name} ${ENGINE.version} (node ${process.version}, sqlite ${sqlite}, fts5 ${fts5})\n`);
      return 0;
    }
    case 'federate': {
      const system = one(options, 'system');
      const out = one(options, 'out');
      if (!system || !out) throw new SystemConfigError('federate needs --system and --out');
      const started = Date.now();
      const config = readSystem(system, inputOverrides(options));
      const states = loadInputs(config);
      for (const s of states) {
        const v = s.verification;
        process.stderr.write(`input ${s.name}: ${!v.ok ? 'failed' : v.references.length ? 'ok with defects' : 'ok'}${v.errors.length ? ` (${v.errors[0]})` : ''}\n`);
      }
      if (!states.some((s) => s.input)) {
        process.stderr.write('no input passed verification: nothing to federate\n');
        return 51;
      }
      const fed = federate(config, states);
      const result = writeSystemGeneration(fed, out, started);
      process.stderr.write(`system generation ${out}: ${result.status}; ${result.counts.systemLinks} cross-repository links, ${result.counts.packageLinks} package links, ${result.counts.traces} traces\n`);
      return 0;
    }
    case 'verify': {
      const dir = positional[0];
      if (!dir) throw new SystemConfigError('verify needs a system generation directory');
      const r = verifySystemGeneration(dir, inputOverrides(options));
      for (const e of r.errors) process.stdout.write(`error: ${e}\n`);
      for (const n of r.notes.slice(0, 20)) process.stdout.write(`note: ${n}\n`);
      if (r.notes.length > 20) process.stdout.write(`note: ${r.notes.length - 20} more notes\n`);
      process.stdout.write(r.ok ? 'ok\n' : 'failed\n');
      return r.ok ? 0 : 50;
    }
    case 'evaluate': {
      const dir = positional[0];
      const expected = one(options, 'expected');
      if (!dir || !expected) throw new SystemConfigError('evaluate needs a system generation and --expected');
      const result = evaluate(dir, expected);
      const report = one(options, 'report');
      const json = one(options, 'json');
      if (report) writeFileSync(report, renderReport(result));
      if (json) writeFileSync(json, JSON.stringify(result, null, 2) + '\n');
      const t = result.totals;
      process.stdout.write(`precision ${t.precision} (${t.truePositives}/${t.truePositives + t.falsePositives}), recall ${t.recall} (${t.truePositives}/${t.expected})\n`);
      return 0;
    }
    case 'list-inputs': {
      const system = one(options, 'system');
      if (!system) throw new SystemConfigError('list-inputs needs --system');
      for (const g of readSystem(system).generations) process.stdout.write(`${g.name}\t${g.oci ?? '-'}\n`);
      return 0;
    }
    case 'gha':
      return runGitHubAction();
    case 'dump-index': {
      const dir = positional[0];
      if (!dir) throw new SystemConfigError('dump-index needs a system generation directory');
      process.stdout.write(indexDump(dir));
      return 0;
    }
    default:
      throw new SystemConfigError(`unknown command '${command}'\n\n${USAGE}`);
  }
}

try {
  process.exitCode = main(process.argv.slice(2));
} catch (e) {
  if (e instanceof SystemConfigError) {
    process.stderr.write(`${e.message}\n`);
    process.exitCode = 2;
  } else throw e;
}
