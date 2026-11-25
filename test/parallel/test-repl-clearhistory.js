'use strict';

const common = require('../common');
const assert = require('assert');
const fs = require('fs');
const { spawnSync } = require('child_process');
const { once } = require('events');
const repl = require('repl');
const { PassThrough } = require('stream');
const { test } = require('node:test');
const tmpdir = require('../common/tmpdir');

common.skipIfInspectorDisabled();
if (process.env.TERM === 'dumb') common.skip('skipping - dumb terminal');
tmpdir.refresh();

function start(t) {
  const input = new PassThrough();
  const output = new PassThrough();
  const r = repl.start({ input, output, terminal: true, useColors: false });
  r.outputText = '';
  output.on('data', (chunk) => { r.outputText += chunk; });
  t.after(async () => {
    if (!r.closed) {
      const closed = once(r, 'close');
      r.close();
      await closed;
    }
  });
  return r;
}

function setupHistory(r, filePath) {
  return new Promise((resolve, reject) => {
    r.setupHistory(filePath, (err) => err ? reject(err) : resolve());
  });
}

function command(r, line) {
  r.outputText = '';
  return new Promise((resolve) => {
    const displayPrompt = r.displayPrompt;
    r.displayPrompt = function(...args) {
      r.displayPrompt = displayPrompt;
      displayPrompt.apply(this, args);
      setImmediate(resolve);
    };
    r.input.write(`${line}\n`);
  });
}

test('clears memory without changing context; remains usable and overridable', async (t) => {
  const r = start(t);
  await command(r, 'var value = 42');
  await command(r, '.help');
  assert.match(r.outputText, /\.clearhistory\s+Clear in-memory and persisted REPL history/);
  await command(r, '.clearhistory');
  assert.deepStrictEqual(r.history, []);
  assert.strictEqual(r.historyIndex, -1);
  assert.match(r.outputText, /History cleared\n/);
  assert.strictEqual(r.context.value, 42);
  r.write(null, { name: 'up' });
  assert.strictEqual(r.line, '');
  await command(r, '.clearhistory');
  assert.deepStrictEqual(r.history, []);
  await command(r, '.break');
  await command(r, 'value');
  assert.match(r.outputText, /42/);
  r.defineCommand('clearhistory', function() {
    this.output.write('custom command\n');
    this.displayPrompt();
  });
  await command(r, '.clearhistory');
  assert.match(r.outputText, /custom command/);
});

test('clears persisted history and a new session starts empty', async (t) => {
  const historyPath = tmpdir.resolve('restart-history');
  fs.writeFileSync(historyPath, 'old entry\nolder entry');
  const r = start(t);
  await setupHistory(r, historyPath);
  assert.deepStrictEqual(r.history, ['old entry', 'older entry']);
  await command(r, '1 + 1');
  await command(r, '.clearhistory');
  assert.deepStrictEqual(r.history, []);
  assert.strictEqual(fs.readFileSync(historyPath, 'utf8'), '');
  const closed = once(r, 'close');
  r.close();
  await closed;

  const child = spawnSync(process.execPath, [...process.execArgv, '-e', `
    const assert = require('assert');
    const { PassThrough } = require('stream');
    const r = require('repl').start({
      input: new PassThrough(), output: new PassThrough(), terminal: true,
    });
    r.setupHistory(process.argv[1], (err) => {
      assert.ifError(err);
      assert.deepStrictEqual(r.history, []);
      r.close();
    });
  `, historyPath], { encoding: 'utf8' });
  assert.strictEqual(child.status, 0, child.stderr);

  const next = start(t);
  await setupHistory(next, historyPath);
  assert.deepStrictEqual(next.history, []);
  await command(next, '.clearhistory');
  await command(next, '2 + 2');
  await once(next, 'flushHistory');
  assert.strictEqual(fs.readFileSync(historyPath, 'utf8'), '2 + 2');
});

test('works when persistence is explicitly disabled', async (t) => {
  const r = start(t);
  await setupHistory(r, '');
  await command(r, '123');
  await command(r, '.clearhistory');
  assert.deepStrictEqual(r.history, []);
  assert.match(r.outputText, /History cleared\n/);
});

test('reports persistence failures and supports retry', async (t) => {
  const historyPath = tmpdir.resolve('failed-history');
  fs.writeFileSync(historyPath, 'old entry');
  let handle;
  const open = fs.promises.open;
  t.mock.method(fs.promises, 'open', async (...args) => {
    const result = await open(...args);
    if (args[0] === historyPath && args[1] === 'r+') handle = result;
    return result;
  });
  const r = start(t);
  await setupHistory(r, historyPath);
  const failure = t.mock.method(handle, 'truncate', async () => {
    throw Object.assign(new Error('permission denied'), { code: 'EACCES' });
  });
  await command(r, '.clearhistory');
  assert.match(r.outputText, /Error: Could not clear history: permission denied/);
  assert.doesNotMatch(r.outputText, /History cleared/);
  assert.deepStrictEqual(r.history, []);
  assert.strictEqual(fs.readFileSync(historyPath, 'utf8'), 'old entry');
  failure.mock.restore();
  await command(r, '.clearhistory');
  assert.match(r.outputText, /History cleared\n/);
  assert.strictEqual(fs.readFileSync(historyPath, 'utf8'), '');
});

test('does not claim to clear a history file that failed to open', async (t) => {
  const r = start(t);
  await setupHistory(r, tmpdir.resolve('missing-directory', 'history'));
  await command(r, '123');
  await command(r, '.clearhistory');
  assert.deepStrictEqual(r.history, []);
  assert.match(r.outputText, /Error: Could not clear history:/);
  assert.doesNotMatch(r.outputText, /History cleared/);
});

test('closing immediately after the command waits for clearing', async (t) => {
  const historyPath = tmpdir.resolve('close-history');
  fs.writeFileSync(historyPath, 'old entry');
  const r = start(t);
  await setupHistory(r, historyPath);
  const closed = once(r, 'close');
  r.input.write('.clearhistory\n');
  r.close();
  await closed;
  assert.strictEqual(fs.readFileSync(historyPath, 'utf8'), '');
});
