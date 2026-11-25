'use strict';

// Flags: --expose-internals

const common = require('../common');
const assert = require('assert');
const fs = require('fs');
const { EventEmitter, once } = require('events');
const { ReplHistory } = require('internal/repl/history');
const { test } = require('node:test');
const tmpdir = require('../common/tmpdir');

tmpdir.refresh();

async function history(t, name, entries = 'old entry\nolder entry') {
  const filePath = tmpdir.resolve(name);
  fs.writeFileSync(filePath, entries);
  const context = new EventEmitter();
  context.pause = context.resume = () => {};
  const manager = new ReplHistory(context, { filePath });
  await new Promise((resolve) => manager.initialize(common.mustSucceed(resolve)));
  t.after(() => manager.closeHandle());
  return { manager, context, filePath };
}

function addLine(manager, context, line) {
  context.line = line;
  manager.addHistory(false, false);
  context.emit('line', line);
}

test('clears pending writes, notifies history listeners and resets navigation', async (t) => {
  const { manager, context, filePath } = await history(t, 'pending');
  addLine(manager, context, 'new entry');
  manager.navigateToPrevious();
  context.once('history', common.mustCall((entries) => {
    assert.deepStrictEqual(entries, []);
  }));
  await manager.clearHistory();
  assert.deepStrictEqual(manager.history, []);
  assert.strictEqual(manager.index, -1);
  assert.strictEqual(manager.canNavigateToPrevious(), false);
  assert.strictEqual(manager.isFlushing, false);
  assert.strictEqual(fs.readFileSync(filePath, 'utf8'), '');

  const nextContext = new EventEmitter();
  nextContext.pause = nextContext.resume = () => {};
  const next = new ReplHistory(nextContext, { filePath });
  await new Promise((resolve) => next.initialize(common.mustSucceed(resolve)));
  assert.deepStrictEqual(next.history, []);
  await next.closeHandle();

  await manager.clearHistory();
  addLine(manager, context, 'after clear');
  await once(context, 'flushHistory');
  assert.strictEqual(fs.readFileSync(filePath, 'utf8'), 'after clear');
});

test('waits for a write already in progress before truncating', async (t) => {
  const open = fs.promises.open;
  let handle;
  t.mock.method(fs.promises, 'open', async (...args) => {
    const result = await open(...args);
    if (args[1] === 'r+') handle = result;
    return result;
  });
  const { manager, context, filePath } = await history(t, 'in-progress');
  const write = handle.write.bind(handle);
  const { promise: started, resolve: markStarted } = Promise.withResolvers();
  const { promise: released, resolve: release } = Promise.withResolvers();
  t.mock.method(handle, 'write', async (...args) => {
    markStarted();
    await released;
    return write(...args);
  });
  addLine(manager, context, 'in progress');
  await started;
  const clearing = manager.clearHistory();
  // Let the debounce timer expire while the old write is still blocked.
  await new Promise((resolve) => setTimeout(resolve, 30));
  release();
  await clearing;
  assert.deepStrictEqual(manager.history, []);
  assert.strictEqual(fs.readFileSync(filePath, 'utf8'), '');
});

test('failed truncation rejects without leaving the manager flushing', async (t) => {
  const open = fs.promises.open;
  let handle;
  t.mock.method(fs.promises, 'open', async (...args) => {
    const result = await open(...args);
    if (args[1] === 'r+') handle = result;
    return result;
  });
  const { manager, filePath } = await history(t, 'failure');
  const failure = t.mock.method(handle, 'truncate', async () => {
    throw Object.assign(new Error('permission denied'), { code: 'EACCES' });
  });
  await assert.rejects(manager.clearHistory(), { code: 'EACCES' });
  assert.deepStrictEqual(manager.history, []);
  assert.strictEqual(manager.isFlushing, false);
  assert.strictEqual(fs.readFileSync(filePath, 'utf8'), 'old entry\nolder entry');
  failure.mock.restore();
  await manager.clearHistory();
  assert.strictEqual(fs.readFileSync(filePath, 'utf8'), '');
});

test('clears while initialization is still loading the history file', async (t) => {
  const filePath = tmpdir.resolve('initializing');
  fs.writeFileSync(filePath, 'old entry');
  const context = new EventEmitter();
  context.pause = context.resume = () => {};
  const manager = new ReplHistory(context, { filePath });
  t.after(() => manager.closeHandle());
  manager.initialize(common.mustSucceed());
  await manager.clearHistory();
  assert.deepStrictEqual(manager.history, []);
  assert.strictEqual(fs.readFileSync(filePath, 'utf8'), '');
});

test('a missing history file is treated as empty', async (t) => {
  const { manager, filePath } = await history(t, 'removed');
  fs.unlinkSync(filePath);
  await manager.clearHistory();
  assert.deepStrictEqual(manager.history, []);
  assert.strictEqual(fs.existsSync(filePath), false);
});
