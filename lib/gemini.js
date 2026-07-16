'use strict';

// ============================================================================
// gemini.js — OPTIONAL narrator / second-opinion layer.
// It is fed the NUMBERS the deterministic engine already computed (never an
// image), and asked to (a) rewrite the justification in natural Romanian and
// (b) give an agreement check. It does NOT decide direction — the engine does.
// If disabled or on any error, the engine's own text is used as fallback.
// ============================================================================

function buildPrompt(symbol, verdict) {
  const snap = JSON.stringify(verdict.snapshots, null, 0);
  const sig = verdict.signals.map((s) => `- ${s.label} [${s.tf}] pondere ${s.weight}`).join('\n');
  return `Ești un analist tehnic crypto sobru și onest. Un motor determinist a analizat ${symbol} pentru un contract event-futures (UP/DOWN pe 10 sau 30 minute) și a produs verdictul de mai jos DEJA. Rolul tău NU este să schimbi direcția, ci să:
1) rescrii "justificare" într-un paragraf clar, natural, în limba română (2-4 propoziții), fără clișee și fără hype;
2) evaluezi dacă ești DE ACORD cu direcția pe baza numerelor (acord: "da"/"partial"/"nu");
3) semnalezi orice risc imediat (ex. RSI extrem, chop, posibil whipsaw).

Verdict motor:
- Direcție: ${verdict.directie}
- Interval: ${verdict.interval}
- Încredere: ${verdict.incredere}
- Scoruri: up=${verdict.scores.up} down=${verdict.scores.down} net=${verdict.scores.net}
- Semnale care susțin direcția:
${sig || '(niciunul)'}
- Snapshot indicatori pe timeframe: ${snap}

Răspunde STRICT în JSON valid, fără text în plus, cu forma:
{"justificare": "...", "acord": "da|partial|nu", "risc": "...", "comentariu": "..."}`;
}

async function narrate(symbol, verdict, cfg) {
  if (!cfg || !cfg.enabled || !cfg.apiKey) {
    return { used: false };
  }
  const model = cfg.model || 'gemini-3.5-flash';
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(cfg.apiKey)}`;
  const body = {
    contents: [{ parts: [{ text: buildPrompt(symbol, verdict) }] }],
    generationConfig: { temperature: 0.4, maxOutputTokens: 500, responseMimeType: 'application/json' },
  };
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const t = await res.text().catch(() => '');
      return { used: false, error: `HTTP ${res.status} ${t.slice(0, 150)}` };
    }
    const json = await res.json();
    const text = json?.candidates?.[0]?.content?.parts?.[0]?.text || '';
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      const m = text.match(/\{[\s\S]*\}/);
      parsed = m ? JSON.parse(m[0]) : null;
    }
    if (!parsed) return { used: false, error: 'unparseable AI response' };
    return { used: true, ...parsed };
  } catch (e) {
    return { used: false, error: String(e.message || e) };
  }
}

// Quick key test used by the UI "Test AI key" button.
async function testKey(cfg) {
  if (!cfg || !cfg.apiKey) return { ok: false, error: 'no key' };
  const model = cfg.model || 'gemini-3.5-flash';
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(cfg.apiKey)}`;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contents: [{ parts: [{ text: 'Raspunde cu un singur cuvant: ok' }] }] }),
    });
    if (!res.ok) {
      const t = await res.text().catch(() => '');
      return { ok: false, error: `HTTP ${res.status} ${t.slice(0, 150)}` };
    }
    return { ok: true, model };
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
}

module.exports = { narrate, testKey, buildPrompt };
