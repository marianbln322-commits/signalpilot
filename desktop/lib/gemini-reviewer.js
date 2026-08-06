'use strict';

const DEFAULT_MODEL = 'gemini-3-pro-preview';
const BASE_URL = 'https://generativelanguage.googleapis.com/v1beta';

function safeEntryPayload(entry) {
  return {
    symbol: entry.symbol,
    horizonMin: entry.horizonMin,
    direction: entry.direction,
    quality: entry.quality,
    trigger: entry.trigger,
    features: entry.features,
    entryPrice: entry.entryPrice,
    exitPrice: entry.exitPrice,
    deterministicReview: entry.review,
  };
}

function validateStructuredReview(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Gemini review must be an object');
  const stringField = (name, maximum = 2_000) => {
    if (typeof value[name] !== 'string') throw new Error(`Gemini review ${name} must be a string`);
    const text = value[name].trim();
    if (!text || text.length > maximum) throw new Error(`Gemini review ${name} length is invalid`);
    return text;
  };
  const arrayField = (name) => {
    if (!Array.isArray(value[name]) || value[name].length > 12) throw new Error(`Gemini review ${name} must be an array with at most 12 items`);
    return value[name].map((item) => {
      if (typeof item !== 'string') throw new Error(`Gemini review ${name} items must be strings`);
      const text = item.trim();
      if (!text || text.length > 500) throw new Error(`Gemini review ${name} item length is invalid`);
      return text;
    });
  };
  const confidence = stringField('confidence', 6);
  if (!['LOW', 'MEDIUM', 'HIGH'].includes(confidence)) throw new Error('Gemini review confidence is invalid');
  return {
    diagnosis: stringField('diagnosis'),
    confidence,
    observedWeaknesses: arrayField('observedWeaknesses'),
    alternativeExplanations: arrayField('alternativeExplanations'),
    researchChecks: arrayField('researchChecks'),
    doNotChangeYet: arrayField('doNotChangeYet'),
  };
}

class GeminiLossReviewer {
  constructor({ apiKey = process.env.GEMINI_API_KEY, model = process.env.GEMINI_MODEL || DEFAULT_MODEL, fetchImpl = fetch } = {}) {
    this.apiKey = apiKey || null;
    this.model = model;
    this.fetchImpl = fetchImpl;
    this.inFlight = false;
    this.lastError = null;
    this.lastReviewedAt = null;
  }

  status() {
    return {
      enabled: Boolean(this.apiKey),
      model: this.model,
      role: 'post-loss reviewer only; cannot create, flip, or approve live signals',
      inFlight: this.inFlight,
      lastError: this.lastError,
      lastReviewedAt: this.lastReviewedAt,
    };
  }

  async review(entry, { timeoutMs = 30_000 } = {}) {
    if (!this.apiKey) return null;
    if (!entry || entry.status !== 'resolved' || entry.win !== false || !entry.review || entry.review.complete === false) return null;
    if (this.inFlight) throw new Error('Gemini reviewer already has a request in flight');
    this.inFlight = true;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const prompt = [
        'Ești auditor post-trade pentru un sistem de Event Futures. Analizează numai pierderea deja închisă.',
        'Nu inventa date, nu promite precizie, nu recomanda mărirea mizei și nu produce un nou semnal UP/DOWN.',
        'Separă cauza probabilă de simpla variație adversă. Propune doar verificări măsurabile pentru cercetare walk-forward.',
        `Date JSON: ${JSON.stringify(safeEntryPayload(entry))}`,
      ].join('\n');
      const response = await this.fetchImpl(`${BASE_URL}/models/${encodeURIComponent(this.model)}:generateContent`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': this.apiKey },
        signal: controller.signal,
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [{ text: prompt }] }],
          generationConfig: {
            temperature: 0.1,
            responseMimeType: 'application/json',
            responseJsonSchema: {
              type: 'object',
              properties: {
                diagnosis: { type: 'string' },
                confidence: { type: 'string', enum: ['LOW', 'MEDIUM', 'HIGH'] },
                observedWeaknesses: { type: 'array', items: { type: 'string' } },
                alternativeExplanations: { type: 'array', items: { type: 'string' } },
                researchChecks: { type: 'array', items: { type: 'string' } },
                doNotChangeYet: { type: 'array', items: { type: 'string' } },
              },
              required: ['diagnosis', 'confidence', 'observedWeaknesses', 'alternativeExplanations', 'researchChecks', 'doNotChangeYet'],
              additionalProperties: false,
            },
          },
        }),
      });
      const body = await response.text();
      if (!response.ok) throw new Error(`Gemini HTTP ${response.status}: ${body.slice(0, 240)}`);
      const payload = JSON.parse(body);
      const text = payload && payload.candidates && payload.candidates[0]
        && payload.candidates[0].content && payload.candidates[0].content.parts
        && payload.candidates[0].content.parts.map((part) => part.text || '').join('');
      if (!text) throw new Error('Gemini returned no structured review text');
      const parsed = validateStructuredReview(JSON.parse(text));
      const result = { ...parsed, model: this.model, source: 'Gemini structured post-loss review' };
      this.lastError = null;
      this.lastReviewedAt = Date.now();
      return result;
    } catch (error) {
      this.lastError = error.name === 'AbortError' ? `timeout after ${timeoutMs}ms` : error.message;
      throw new Error(this.lastError);
    } finally {
      clearTimeout(timer);
      this.inFlight = false;
    }
  }
}

module.exports = { GeminiLossReviewer, DEFAULT_MODEL, safeEntryPayload, validateStructuredReview };
