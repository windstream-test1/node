import '../common/index.mjs';
import assert from 'node:assert/strict';
import { startNewREPLServer } from '../common/repl.js';

const globalObject = globalThis;
const globalThisDescriptor = Object.getOwnPropertyDescriptor(globalObject, 'globalThis');

for (const useGlobal of [false, true]) {
  const { replServer, output, run } = startNewREPLServer({
    terminal: false,
    useColors: false,
    useGlobal,
  });

  async function check(input, expected) {
    output.accumulator = '';
    await run([input]);
    assert.match(output.accumulator, expected);
  }

  try {
    await check('delete globalThis', /^true\n$/);
    await check('typeof globalThis', /^'undefined'\n$/);
    await check('Math', /\[Math\]/);
    await check('JSON', /\[JSON\]/);
    await check('Object', /\[Function: Object\]/);
    await check('JSON.stringify({ pi: Math.PI })', /3\.141592653589793/);

    await check('a', /^Uncaught ReferenceError: a is not defined\n/);
    await check('21 * 2', /^42\n$/);
    await check('!@#$%^&[]', /^Uncaught SyntaxError:/);
    await check('21 * 2', /^42\n$/);

    await check('({', /^\| $/);
    await check('answer: 42 })', /^\{ answer: 42 \}\n$/);
  } finally {
    Object.defineProperty(globalObject, 'globalThis', globalThisDescriptor);
    replServer.close();
  }
}
