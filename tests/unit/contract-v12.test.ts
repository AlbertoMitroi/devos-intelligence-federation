// The contract v1.2 examples (docs/CONTRACT-v1.2.md): real time through realtime.connection with method names compared
// case-insensitively, call-site values of a package helper's destination parameter (C7), in-process dispatch (C8).
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { federate, loadInputs } from '../../src/federate.ts';
import { verifySystemGeneration, writeSystemGeneration } from '../../src/generation.ts';
import { verifyInput } from '../../src/input.ts';
import type { Rec } from '../../src/records.ts';
import { readSystem } from '../../src/system.ts';
import { tempDir, writeGeneration } from './helpers.ts';

const HUBS = 'src/Lab.Core.MessageHubs/Lab.Core.MessageHubs.csproj';
const APP = 'src/Leasing.AppServices/Leasing.AppServices.csproj';
const HOST = 'src/Leasing.Host/Leasing.Host.csproj';
const SEND_ALL = 'M:Lab.Core.MessageHubs.IMessageHubUtility.SendToAll(System.String,System.Object)';
const SEND_USERS = 'M:Lab.Core.MessageHubs.IMessageHubUtility.SendToSpecifiedUsers(System.Collections.Generic.IReadOnlyCollection{System.String},System.String,System.Object)';
const PKG = (doc: string) => `dotnet:pkg:Lab.Core.MessageHubs@1.0.0:Lab.Core.MessageHubs:${doc}`;
const PROJECT = `dotnet:${APP}:M:Leasing.AppServices.Projections.FlowProjectionService.Project`;

function realtimeSystem(root: string, withArguments: boolean): string {
  writeGeneration(join(root, 'core'), {
    remoteUrl: 'https://example.test/core.git',
    projects: [{ path: HUBS, extra: { packageId: 'Lab.Core.MessageHubs', packageVersion: '1.0.0', isPackable: true } }],
    entities: [
      { id: `dotnet:${HUBS}:${SEND_ALL}`, project: HUBS },
      { id: `dotnet:${HUBS}:${SEND_USERS}`, project: HUBS },
      { id: `dotnet:${HUBS}:M:Lab.Core.MessageHubs.MessageHubUtility\`1.SendToAll(System.String,System.Object)`, project: HUBS },
      { id: `dotnet:${HUBS}:M:Lab.Core.MessageHubs.MessageHubUtility\`1.SendToSpecifiedUsers(System.Collections.Generic.IReadOnlyCollection{System.String},System.String,System.Object)`, project: HUBS },
    ],
    relations: [
      { from: `dotnet:${HUBS}:M:Lab.Core.MessageHubs.MessageHubUtility\`1.SendToAll(System.String,System.Object)`, to: `dotnet:${HUBS}:${SEND_ALL}`, kind: 'implements', project: HUBS },
      { from: `dotnet:${HUBS}:M:Lab.Core.MessageHubs.MessageHubUtility\`1.SendToSpecifiedUsers(System.Collections.Generic.IReadOnlyCollection{System.String},System.String,System.Object)`, to: `dotnet:${HUBS}:${SEND_USERS}`, kind: 'implements', project: HUBS },
    ],
    observations: [
      { kind: 'realtime.send', project: HUBS, sender: `dotnet:${HUBS}:M:Lab.Core.MessageHubs.MessageHubUtility\`1.SendToAll(System.String,System.Object)`, hub: null, method: null, audience: 'all', resolution: 'unresolved', destinationParameter: { field: 'method', parameter: 'method', ordinal: 0 } },
      { kind: 'realtime.send', project: HUBS, sender: `dotnet:${HUBS}:M:Lab.Core.MessageHubs.MessageHubUtility\`1.SendToSpecifiedUsers(System.Collections.Generic.IReadOnlyCollection{System.String},System.String,System.Object)`, hub: null, method: null, audience: 'users', resolution: 'unresolved', destinationParameter: { field: 'method', parameter: 'method', ordinal: 1 } },
    ],
  });
  const args = withArguments
    ? [
        { kind: 'call.argument', project: APP, caller: PROJECT, callee: PKG(SEND_ALL), parameter: 'method', ordinal: 0, value: 'flowUpdated', valueSource: 'literal', role: { kind: 'realtime.send', field: 'method' }, basis: 'generation', resolution: 'exact' },
        { kind: 'call.argument', project: APP, caller: PROJECT, callee: PKG(SEND_USERS), parameter: 'method', ordinal: 1, value: 'taskAssigned', valueSource: 'constant', role: { kind: 'realtime.send', field: 'method' }, basis: 'generation', resolution: 'exact' },
      ]
    : [];
  writeGeneration(join(root, 'leasing'), {
    remoteUrl: 'https://example.test/leasing.git',
    projects: [{ path: APP, extra: { packages: [{ id: 'Lab.Core.MessageHubs', version: '1.0.0', direct: true }] } }, { path: HOST }],
    entities: [
      { id: PROJECT, project: APP },
      { id: PKG(SEND_ALL), project: APP },
      { id: PKG(SEND_USERS), project: APP },
      { id: `dotnet:${HOST}:T:Leasing.Host.Hubs.LeasingHub`, project: HOST },
    ],
    relations: [
      { from: PROJECT, to: PKG(SEND_ALL), kind: 'calls_declared_target', project: APP },
      { from: PROJECT, to: PKG(SEND_USERS), kind: 'calls_declared_target', project: APP },
    ],
    observations: [{ kind: 'realtime.hub', project: HOST, hub: `dotnet:${HOST}:T:Leasing.Host.Hubs.LeasingHub`, route: '/hubs/leasing', canonicalRoute: '/hubs/leasing', resolution: 'exact' }, ...args],
  });
  const client = 'ts:.:src/app/core/realtime/leasing-hub.service#LeasingHubService';
  const baseAddress = { key: 'environment.apiUrl', nameSource: 'configuration', source: 'environment', values: [{ value: 'http://localhost:5080' }] };
  writeGeneration(join(root, 'web'), {
    remoteUrl: 'https://example.test/web.git',
    engine: 'angular-intelligence',
    projects: [{ path: '.' }],
    entities: [{ id: client, project: '.' }],
    observations: [
      { kind: 'realtime.connection', project: '.', route: '/hubs/leasing', urlTemplate: '{environment.apiUrl}/hubs/leasing', baseAddress, client, resolution: 'exact' },
      // The SignalR JavaScript client lowercases method names: one subscription is written lower case on purpose.
      { kind: 'realtime.subscribe', project: '.', route: '/hubs/leasing', hub: '{environment.apiUrl}/hubs/leasing', method: 'flowupdated', client, resolution: 'exact' },
      { kind: 'realtime.subscribe', project: '.', route: '/hubs/leasing', hub: '{environment.apiUrl}/hubs/leasing', method: 'taskAssigned', client, resolution: 'exact' },
    ],
  });
  const file = join(root, 'system.yml');
  writeFileSync(file, 'system: rt\ngenerations:\n  - { name: core, path: core }\n  - { name: leasing, path: leasing }\n  - { name: web, path: web }\nroutes:\n  - { from: web, baseUrl: environment.apiUrl, to: leasing }\n');
  return file;
}

const pushes = (links: Rec[]) => links.filter((l) => l.kind === 'pushes_to');

test('real time: connection route, call-site method names, case-insensitive match give exact one-to-one links', () => {
  const root = tempDir();
  const file = realtimeSystem(root, true);
  for (const d of ['core', 'leasing', 'web']) assert.deepEqual(verifyInput(join(root, d)).errors, [], d);
  const config = readSystem(file);
  const fed = federate(config, loadInputs(config));
  const links = pushes(fed.links);
  assert.equal(links.length, 2);
  for (const l of links) assert.equal(l.resolution, 'exact', String(l.reason));
  const pair = (l: Rec) => `${(l.from as Rec).argument && ((l.from as Rec).argument as Rec).value} -> ${(l.match as Rec).method}`;
  assert.deepEqual(links.map(pair).sort(), ['flowUpdated -> flowupdated', 'taskAssigned -> taskAssigned']);
  assert.ok(links.every((l) => (l.from as Rec).entity === `leasing/${PROJECT}`));
  const out = join(root, 'out');
  writeSystemGeneration(fed, out, 0);
  assert.deepEqual(verifySystemGeneration(out).errors, []);
});

test('real time: without call-site values every send matches every subscription, as candidates with the reason', () => {
  const root = tempDir();
  const config = readSystem(realtimeSystem(root, false));
  const links = pushes(federate(config, loadInputs(config)).links);
  assert.equal(links.length, 4);
  for (const l of links) {
    assert.equal(l.resolution, 'candidate');
    assert.match(String(l.reason), /method name is an argument of the package method/);
  }
});

const S = 'src/Shared/Shared.csproj';
const CMD = 'T:Shared.SignContractCommand';

function dispatchSystem(root: string, handlers: number, concrete = true): string {
  writeGeneration(join(root, 'shared'), {
    remoteUrl: 'https://example.test/shared.git',
    projects: [{ path: S, extra: { packageId: 'Shared', packageVersion: '1.0.0', isPackable: true } }],
    entities: [{ id: `dotnet:${S}:${CMD}`, project: S }, ...Array.from({ length: handlers }, (_, i) => ({ id: `dotnet:${S}:T:Shared.SignHandler${i}`, project: S }))],
    observations: Array.from({ length: handlers }, (_, i) => ({ kind: 'inprocess.handler', project: S, request: `dotnet:${S}:${CMD}`, handler: `dotnet:${S}:T:Shared.SignHandler${i}`, mechanism: 'mediatr', pattern: 'request', resolution: 'exact' })),
  });
  writeGeneration(join(root, 'api'), {
    remoteUrl: 'https://example.test/api.git',
    projects: [{ path: APP, extra: { packages: [{ id: 'Shared', version: '1.0.0', direct: true }] } }],
    entities: [{ id: `dotnet:${APP}:M:Api.LeasesController.Sign`, project: APP }, { id: `dotnet:pkg:Shared@1.0.0:Shared:${CMD}`, project: APP }],
    relations: [{ from: `dotnet:${APP}:M:Api.LeasesController.Sign`, to: `dotnet:pkg:Shared@1.0.0:Shared:${CMD}`, kind: 'references', usage: 'other', project: APP }],
    observations: [{ kind: 'inprocess.send', project: APP, request: `dotnet:pkg:Shared@1.0.0:Shared:${CMD}`, sender: `dotnet:${APP}:M:Api.LeasesController.Sign`, mechanism: 'mediatr', pattern: 'request', resolution: concrete ? 'exact' : 'candidate' }],
  });
  const file = join(root, 'system.yml');
  writeFileSync(file, 'system: dispatch\ngenerations:\n  - { name: shared, path: shared }\n  - { name: api, path: api }\n');
  return file;
}

const dispatches = (root: string, handlers: number, concrete = true) => {
  const config = readSystem(dispatchSystem(root, handlers, concrete));
  return federate(config, loadInputs(config)).links.filter((l) => l.kind === 'dispatches_to');
};

test('dispatch across inputs: one handler exact, several ambiguous, none unresolved, candidate send candidate', () => {
  const one = dispatches(tempDir(), 1);
  assert.equal(one.length, 1);
  assert.equal(one[0].resolution, 'exact');
  assert.equal((one[0].to as Rec).entity, `shared/dotnet:${S}:T:Shared.SignHandler0`);
  const two = dispatches(tempDir(), 2);
  assert.equal(two.length, 2);
  assert.ok(two.every((l) => l.resolution === 'ambiguous'));
  const none = dispatches(tempDir(), 0);
  assert.equal(none.length, 1);
  assert.equal(none[0].resolution, 'unresolved');
  assert.match(String(none[0].reason), /no handler in the system/);
  const candidate = dispatches(tempDir(), 1, false);
  assert.equal(candidate[0].resolution, 'candidate');
});

test('a substituted route or URL template is canonicalized like an engine route', async () => {
  const { canonicalRoute } = await import('../../src/arguments.ts');
  assert.equal(canonicalRoute('api/Rate-Cards/{code}?expand=1'), '/api/rate-cards/{}');
  assert.equal(canonicalRoute('https://host:5081/api/files/{**path}'), '/api/files/{**}');
  assert.equal(canonicalRoute('/v1/quotes/{id?}'), '/v1/quotes/{?}');
});
