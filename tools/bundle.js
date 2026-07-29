'use strict';

// ============================================================================
// bundle.js — regenerates CODE-BUNDLE.md (all source concatenated for review).
//
//   node tools/bundle.js
//
// This exists because the bundle was previously written by hand and went stale:
// it kept serving an outdated copy of every file, so anyone reviewing it read
// code that no longer matched the repository. Generating it removes that risk.
// ============================================================================

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'CODE-BUNDLE.md');

const FILES = [
  'package.json',
  'config.example.json',
  'server.js',
  'lib/candles.js',
  'lib/mexc.js',
  'lib/binance.js',
  'lib/indicators.js',
  'lib/smc.js',
  'lib/engine.js',
  'lib/calibration.js',
  'lib/orderflow.js',
  'lib/learning.js',
  'lib/journal.js',
  'lib/gemini.js',
  'lib/backtest.js',
  'tools/selftest.js',
  'public/index.html',
  'public/app.js',
  'public/style.css',
  'README.md',
];

const LANG = { '.js': 'javascript', '.json': 'json', '.html': 'html', '.css': 'css', '.md': 'markdown' };

const header = `# SignalPilot — pachet complet de cod pentru analiză

Aplicație locală Node.js care citește date live de pe MEXC, calculează indicatori tehnici + Smart Money Concepts + order flow, și produce decizii UP/DOWN pe 10/30 min pentru contracte event-futures.

**Generat automat de \`tools/bundle.js\`.** Nu edita acest fișier direct — regenerează-l.

**Pentru cine analizează codul:** partea esențială nu e lista de indicatori, ci lanțul de decizie:

1. \`lib/candles.js\` — taie lumânarea în formare, ca verdictele să nu se schimbe în timpul barei (*repainting*).
2. \`lib/smc.js\` — Smart Money Concepts; FVG-urile cer *displacement* raportat la ATR și sunt acționabile doar la primul retest.
3. \`lib/engine.js\` — confluență ponderată → direcție + fereastra (10/30 min) dată de declanșatorul principal.
4. \`lib/calibration.js\` — scorul de confluență **nu** e o probabilitate; aici se măsoară empiric ce valorează fiecare bucket și se compară limita inferioară Wilson cu pragul \`1/(1+payout)\`.
5. \`lib/backtest.js\` — evaluare out-of-sample, cu baseline și test de semnificație.

Verificare offline, fără rețea și fără chei: \`node tools/selftest.js\`

Structura:
\`\`\`
${FILES.map((f) => './' + f).join('\n')}
\`\`\`
`;

let out = header;
let missing = [];
for (const rel of FILES) {
  const abs = path.join(ROOT, rel);
  if (!fs.existsSync(abs)) { missing.push(rel); continue; }
  const lang = LANG[path.extname(rel)] || '';
  out += `\n\n## \`${rel}\`\n\n\`\`\`${lang}\n${fs.readFileSync(abs, 'utf8').replace(/\s*$/, '')}\n\`\`\`\n`;
}

fs.writeFileSync(OUT, out);
const lines = out.split('\n').length;
console.log(`CODE-BUNDLE.md regenerated: ${FILES.length - missing.length} files, ${lines} lines`);
if (missing.length) console.log(`  skipped (not found): ${missing.join(', ')}`);
