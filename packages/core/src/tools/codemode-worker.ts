/** Trusted worker program. Untrusted source is evaluated only inside QuickJS, never by Node. */
export const CODEMODE_WORKER_SOURCE = String.raw`
const { parentPort, workerData } = require('node:worker_threads');
(async () => {
  const { getQuickJS } = require(workerData.quickjsModule);
  const Q = await getQuickJS();
  const runtime = Q.newRuntime();
  runtime.setMemoryLimit(workerData.limits.memoryBytes);
  runtime.setMaxStackSize(workerData.limits.stackBytes);
  const deadline = Date.now() + workerData.limits.timeoutMs;
  let ticks = 0;
  runtime.setInterruptHandler(() => Date.now() >= deadline || ++ticks > workerData.limits.interrupts);
  const vm = runtime.newContext();
  const pending = new Map();
  let nextId = 0;
  let finished = false;
  let promiseHandle;
  const fail = message => {
    if (finished) return;
    finished = true;
    parentPort.postMessage({ type: 'failed', error: String(message).slice(0, 2000) });
  };
  const pump = () => {
    if (finished) return;
    const result = runtime.executePendingJobs(128);
    if (result.error) {
      const error = vm.dump(result.error);
      result.error.dispose();
      fail(error && error.message || 'Script execution failed.');
      return;
    }
    if (runtime.hasPendingJob()) setImmediate(pump);
    else if (pending.size === 0) setImmediate(() => {
      if (!finished && !runtime.hasPendingJob() && pending.size === 0) {
        fail('Script is waiting on an unresolved promise.');
      }
    });
  };
  const bridge = vm.newFunction('__hostCall', (...args) => {
    if (pending.size >= workerData.limits.calls || nextId >= workerData.limits.calls) {
      throw new Error('Nested call limit exceeded.');
    }
    const values = args.map(handle => vm.getString(handle));
    if (values.some(value => Buffer.byteLength(value) > workerData.limits.inputBytes)) {
      throw new Error('Nested input limit exceeded.');
    }
    const promise = vm.newPromise();
    const id = ++nextId;
    pending.set(id, promise);
    parentPort.postMessage({ type: 'call', id, operation: values[0], name: values[1], input: values[2] });
    return promise.handle;
  });
  vm.setProp(vm.global, '__hostCall', bridge);
  bridge.dispose();
  const output = vm.newFunction('__output', handle => {
    const value = vm.getString(handle);
    if (Buffer.byteLength(value) > workerData.limits.outputBytes) throw new Error('Script output limit exceeded.');
    parentPort.postMessage({ type: 'output', value });
  });
  vm.setProp(vm.global, '__output', output);
  output.dispose();
  parentPort.on('message', message => {
    if (finished || message.type !== 'response') return;
    const promise = pending.get(message.id);
    if (!promise) return;
    pending.delete(message.id);
    const value = message.error ? vm.newError(message.error) : vm.newString(message.value);
    if (message.error) promise.reject(value); else promise.resolve(value);
    value.dispose();
    promise.dispose();
    pump();
  });
  const prelude = String.raw\`
    (() => {
      const host = globalThis.__hostCall;
      const output = globalThis.__output;
      delete globalThis.__hostCall; delete globalThis.__output;
      const json = value => JSON.stringify(value);
      const call = (op, name, value) => host(op, name, json(value === undefined ? null : value)).then(JSON.parse);
      globalThis.tools = Object.freeze(Object.fromEntries(TOOLS.map(tool => [tool.name,
        args => call('tool', tool.name, args)])));
      globalThis.ALL_TOOLS = Object.freeze(TOOLS.map(tool => Object.freeze({ name: tool.name, description: tool.description })));
      globalThis.searchTools = (query, options = {}) => call('search', '', { query, ...options });
      globalThis.describeTool = name => call('describe', name, null);
      globalThis.describeNamespace = name => call('namespace', name, null);
      globalThis.models = Object.freeze({
        getModelsOfType: type => call('models', type, null),
        getAvailableOfType: type => call('availableModels', type, null),
        getModelOfType: type => call('availableModels', type, null).then(models => models[0]),
        classify: request => call('classify', '', request),
        generateImages: request => call('images', '', request),
      });
      const values = Object.assign(Object.create(null), INITIAL_STORE);
      globalThis.store = (key, value) => {
        if (typeof key !== 'string' || key.length > 128 || !key) throw new Error('Invalid store key.');
        if (value === undefined) delete values[key];
        else {
          const serialized = json(value);
          if (serialized === undefined || serialized.length > 65536) throw new Error('Store value limit exceeded.');
          values[key] = JSON.parse(serialized);
        }
        if (Object.keys(values).length > 128 || json(values).length > 262144) throw new Error('Store limit exceeded.');
      };
      globalThis.load = key => values[key] === undefined ? undefined : JSON.parse(json(values[key]));
      globalThis.text = value => { if (value !== undefined) output(typeof value === 'string' ? value : json(value)); };
      globalThis.console = Object.freeze(Object.fromEntries(['log', 'info', 'warn', 'error', 'debug'].map(name => [name,
        (...args) => text(args.map(value => typeof value === 'string' ? value : json(value)).join(' '))])));
      const exitMarker = Object.freeze({});
      globalThis.exit = () => { throw exitMarker; };
      globalThis.__run = async fn => {
        try { text(await fn()); } catch (error) { if (error !== exitMarker) throw error; }
        return json(values);
      };
    })();
  \`;
  const setup = vm.evalCode('const TOOLS = ' + JSON.stringify(workerData.tools) + '; const INITIAL_STORE = '
    + JSON.stringify(workerData.store) + ';' + prelude, 'codemode-bootstrap.js', { type: 'global' });
  if (setup.error) { const e = vm.dump(setup.error); setup.error.dispose(); fail(e.message); return; }
  setup.value.dispose();
  const evaluated = vm.evalCode('__run(async () => {\n' + workerData.code + '\n})', 'codemode-script.js', { type: 'global' });
  if (evaluated.error) { const e = vm.dump(evaluated.error); evaluated.error.dispose(); fail(e.message); return; }
  promiseHandle = evaluated.value;
  vm.resolvePromise(promiseHandle).then(result => {
    if (finished) return;
    if (result.error) {
      const e = vm.dump(result.error); result.error.dispose(); fail(e && e.message || 'Script failed.');
    } else {
      const store = vm.getString(result.value); result.value.dispose();
      finished = true;
      parentPort.postMessage({ type: 'done', store });
    }
  }).catch(() => fail('Script execution failed.'));
  pump();
})().catch(() => parentPort.postMessage({ type: 'failed', error: 'QuickJS sandbox initialization failed.' }));
`.replaceAll('\\`', '`');
