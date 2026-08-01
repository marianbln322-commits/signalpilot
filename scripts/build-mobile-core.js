'use strict';

const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const modules = [
  'lib/indicators.js',
  'lib/smc.js',
  'lib/engine.js',
  'lib/learning.js',
  'lib/gemini.js',
];

const parts = [
  "'use strict';",
  '(function (global) {',
  '  const modules = Object.create(null);',
  '  const cache = Object.create(null);',
  '  function define(id, factory) { modules[id] = factory; }',
  `  function resolve(from, request) {
    if (!request.startsWith('.')) return request;
    const base = from.split('/');
    base.pop();
    for (const part of request.split('/')) {
      if (!part || part === '.') continue;
      if (part === '..') base.pop();
      else base.push(part);
    }
    const id = base.join('/');
    return id.endsWith('.js') ? id : id + '.js';
  }`,
  `  function load(id) {
    if (cache[id]) return cache[id].exports;
    if (!modules[id]) throw new Error('Mobile bundle module not found: ' + id);
    const module = { exports: {} };
    cache[id] = module;
    modules[id](module, module.exports, (request) => load(resolve(id, request)));
    return module.exports;
  }`,
];

for (const id of modules) {
  const source = fs.readFileSync(path.join(root, id), 'utf8');
  parts.push(`  define(${JSON.stringify(id)}, function (module, exports, require) {\n${source}\n  });`);
}

parts.push(`  global.SignalPilotCore = Object.freeze({
    engine: load('lib/engine.js'),
    learning: load('lib/learning.js'),
    gemini: load('lib/gemini.js'),
  });`);
parts.push('})(window);', '');

const output = path.join(root, 'public', 'mobile-core.js');
fs.writeFileSync(output, parts.join('\n'));
console.log(`Built ${path.relative(root, output)} from ${modules.length} modules.`);
