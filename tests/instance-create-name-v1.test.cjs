'use strict';
// Run only the three public modules involved. Imports with side effects are stubs.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = process.env.EVOLUTION_TEST_SOURCE_ROOT || '/source';
const modules = process.env.EVOLUTION_TEST_NODE_MODULES || '/evolution/node_modules';
const ts = require(path.join(modules, 'typescript'));
const { validate } = require(path.join(modules, 'jsonschema'));

function fixture() {
  const effects = [];
  const warnings = [];
  class BadRequestException extends Error {}
  class Logger {
    warn(message) { warnings.push(message); }
    error() {}
    log() {}
  }
  class InstanceDto {}
  class SetPresenceDto {}
  const integration = { WHATSAPP_BAILEYS: 'WHATSAPP-BAILEYS', WHATSAPP_BUSINESS: 'WHATSAPP-BUSINESS', EVOLUTION: 'EVOLUTION' };
  const instance = {
    connectionStatus: 'close',
    setInstance(data) { effects.push('setInstance'); Object.assign(this, data); },
    sendDataWebhook() { effects.push('webhook'); },
    connectToWhatsapp() { throw new Error('Pairing forbidden in focused tests'); },
  };
  const server = {
    channelController: { init() { effects.push('init'); return instance; } },
    eventManager: { async setInstance() { effects.push('eventSettings'); } },
  };
  const monitor = {
    waInstances: {},
    async saveInstance(data) { effects.push({ save: { ...data } }); },
    delInstanceTime() { effects.push('timer'); },
    deleteInstance() { effects.push('cleanup'); },
  };
  const config = { get() { effects.push('config'); return { ENABLED: false, URL: 'http://localhost' }; } };
  const routerFactory = () => {
    const router = { routes: [] };
    for (const method of ['post', 'get', 'put', 'delete', 'use']) {
      router[method] = (route, ...handlers) => { router.routes.push({ method, route, handlers }); return router; };
    }
    return router;
  };
  const imports = {
    '@config/logger.config': { Logger },
    '@exceptions': { BadRequestException, InternalServerErrorException: Error, UnauthorizedException: Error },
    '@api/server.module': server,
    '@api/types/wa.types': { Integration: integration, Events: { INSTANCE_CREATE: 'instance.create' } },
    '@api/dto/instance.dto': { InstanceDto, SetPresenceDto },
    './index.router': { HttpStatus: { OK: 200, CREATED: 201 } },
    express: { Router: routerFactory },
    jsonschema: { validate },
    uuid: { v4() { effects.push('uuid'); return 'server-generated-id'; } },
    'class-validator': { isArray: Array.isArray, isURL() { throw new Error('Unexpected Chatwoot operation'); } },
    baileys: { delay() { throw new Error('Unexpected pairing delay'); } },
  };
  function load(relative) {
    const source = fs.readFileSync(path.join(root, relative), 'utf8');
    const compiled = ts.transpileModule(source, { compilerOptions: {
      target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true,
    }}).outputText;
    const module = { exports: {} };
    vm.runInNewContext(compiled, {
      module, exports: module.exports,
      require(name) {
        assert.ok(Object.hasOwn(imports, name), `Unstubbed import: ${name}`);
        return imports[name];
      },
    }, { filename: relative });
    return module.exports;
  }
  const schema = load('src/validate/instance.schema.ts');
  imports['@validate/validate.schema'] = schema;
  imports['@api/abstract/abstract.router'] = load('src/api/abstract/abstract.router.ts');
  const { InstanceController } = load('src/api/controllers/instance.controller.ts');
  const settings = { async create() { effects.push('settings'); } };
  const controller = new InstanceController(monitor, config, {}, {}, {}, settings, {}, {}, {}, {}, {});
  server.instanceController = controller;
  const { InstanceRouter } = load('src/api/routes/instance.router.ts');
  const guards = [function authorizationGuard() {}, function instanceScopeGuard() {}];
  const router = new InstanceRouter(config, ...guards);
  effects.length = 0;
  const request = body => ({ body, params: {}, query: {}, originalUrl: '/instance/create' });
  const response = () => ({ status() { return this; }, json(value) { this.value = value; return value; } });
  const route = name => router.router.routes.find(item => item.route === name);
  return { effects, warnings, controller, server, guards, request, response, route };
}

test('valid creation uses the validated DTO and a server-generated identity without pairing', async () => {
  const f = fixture();
  const create = f.route('/create');
  assert.equal(create.handlers[0], f.guards[0]);
  assert.equal(create.handlers[1], f.guards[1]);
  const result = await create.handlers.at(-1)(f.request({ instanceName: '  pilot_test  ',
    instanceId: 'untrusted-id', integration: 'WHATSAPP-BAILEYS', qrcode: false }), f.response());
  assert.equal(result.instance.instanceName, 'pilot_test');
  assert.equal(result.instance.instanceId, 'server-generated-id');
  const saves = f.effects.filter(effect => typeof effect === 'object' && effect.save);
  assert.equal(saves.length, 1);
  assert.equal(saves[0].save.instanceName, 'pilot_test');
  assert.ok(!f.effects.includes('cleanup'));
});

test('create route rejects an empty trimmed name before operational effects', async () => {
  const f = fixture();
  await assert.rejects(() => f.route('/create').handlers.at(-1)(f.request({ instanceName: '   ', qrcode: false }), f.response()));
  assert.equal(f.effects.length, 0);
});

test('other routes retain protected path fields and the original authorization guards', async () => {
  const f = fixture();
  let received;
  for (const method of ['restartInstance', 'connectionState']) {
    f.server.instanceController[method] = async instance => { received = instance; return { ok: true }; };
  }
  for (const name of ['restart', 'connectionState']) {
    const route = f.route('/' + name + '/:instanceName');
    assert.equal(route.handlers[0], f.guards[0]);
    assert.equal(route.handlers[1], f.guards[1]);
    await route.handlers.at(-1)({ params: { instanceName: 'trusted', instanceId: 'trusted-id' },
      query: { instanceName: 'query-override', instanceId: 'query-id' },
      body: { instanceName: 'body-override', instanceId: 'body-id' }, originalUrl: '/instance/' + name + '/trusted' }, f.response());
    assert.equal(received.instanceName, 'trusted');
    assert.equal(received.instanceId, 'trusted-id');
  }
  assert.equal(f.warnings.length, 4);
  assert.equal(f.effects.length, 0);
});

test('invalid controller inputs have no initialization, database, cleanup or generated-ID effects', async () => {
  for (const input of [undefined, null, {}, { instanceName: null }, { instanceName: 42 },
    { instanceName: '' }, { instanceName: '\t\n ' }]) {
    const f = fixture();
    await assert.rejects(() => f.controller.createInstance(input));
    assert.equal(f.effects.length, 0);
  }
});
