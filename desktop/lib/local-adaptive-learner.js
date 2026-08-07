'use strict';

const fs = require('fs');
const path = require('path');
const { contractBoundaries, boundaryState } = require('./contract-timing');
const { atomicWriteJson } = require('./journal');

const STORAGE_SCHEMA_VERSION = 2;
const FEATURE_SCHEMA_VERSION = 'directional-market-v1';
const ALGORITHM_VERSION = 'online-logistic-l2-v1';
const POLICY_VERSION = 'shadow-walk-forward-v1';
const LABEL_POLICY = 'exact-expiry-close; ties-are-losses';
const MINIMUM_EFFECTIVE_SAMPLE = 160;
const MINIMUM_CLASS_SAMPLE = 25;
const MINIMUM_LOG_LOSS_EDGE = 0;
const SAFETY_MARGIN = 0.03;
const LEARNING_RATE = 0.04;
const L2_PENALTY = 0.0005;
const MAX_ABS_WEIGHT = 6;
const EPSILON = 1e-6;

const FEATURE_NAMES = Object.freeze([
  'quality',
  'directionalScoreEdge',
  'triggerStrength',
  'triggerFreshness',
  'confirmingRatio',
  'opposingRatio',
  'executionTrend',
  'executionMomentum',
  'executionStructure',
  'executionVolume',
  'executionRsi',
  'executionRangePosition',
  'executionEmaDistanceAtr',
  'executionAtrPct',
  'executionVolumeRatio',
  'executionTrendStrength',
  'contextAlignment',
]);

const round = (value, digits = 6) => Number.isFinite(value) ? Number(value.toFixed(digits)) : null;
const clip = (value, minimum = -1, maximum = 1) => Math.min(maximum, Math.max(minimum, Number(value) || 0));
const mean = (values) => values.length ? values.reduce((total, value) => total + value, 0) / values.length : 0;

const cloneState = (value) => JSON.parse(JSON.stringify(value));

function sigmoid(value) {
  if (value >= 0) {
    const inverse = Math.exp(-Math.min(35, value));
    return 1 / (1 + inverse);
  }
  const exponential = Math.exp(Math.max(-35, value));
  return exponential / (1 + exponential);
}

function logLoss(probability, label) {
  const safeProbability = clip(probability, EPSILON, 1 - EPSILON);
  return -(label * Math.log(safeProbability) + (1 - label) * Math.log(1 - safeProbability));
}

function bucketKey(symbol, horizonMin) {
  return `${String(symbol || '').toUpperCase()}|${Number(horizonMin)}m`;
}

function directionValue(value, direction) {
  const sign = direction === 'UP' ? 1 : -1;
  const raw = value === 'UP' ? 1 : value === 'DOWN' ? -1 : 0;
  return raw * sign;
}

function executionAnalyses(signal) {
  return (signal.executionTimeframes || [])
    .map((timeframe) => signal.timeframeAnalyses && signal.timeframeAnalyses[timeframe])
    .filter(Boolean);
}

function contextAnalyses(signal) {
  return (signal.contextTimeframes || [])
    .map((timeframe) => signal.timeframeAnalyses && signal.timeframeAnalyses[timeframe])
    .filter(Boolean);
}

function extractFeatures(signal) {
  if (!signal || signal.action !== 'ENTER' || !['UP', 'DOWN'].includes(signal.direction) || !signal.trigger) {
    throw new Error('local learner features require a deterministic ENTER with direction and trigger');
  }
  const direction = signal.direction;
  const sign = direction === 'UP' ? 1 : -1;
  const execution = executionAnalyses(signal);
  const context = contextAnalyses(signal);
  const expectedExecution = Math.max(1, (signal.executionTimeframes || []).length);
  const scoreUp = Number(signal.directionScores && signal.directionScores.up) || 0;
  const scoreDown = Number(signal.directionScores && signal.directionScores.down) || 0;
  const directionalScoreEdge = direction === 'UP' ? scoreUp - scoreDown : scoreDown - scoreUp;
  const triggerAgeMs = Math.max(0, Number(signal.triggerAgeMs) || 0);
  const triggerWindowMs = Math.max(1, Number(signal.triggerWindowMs) || 1);
  const directionalMean = (field) => mean(execution.map((analysis) => directionValue(analysis[field], direction)));
  const features = [
    clip((Number(signal.quality) - 50) / 50),
    clip(directionalScoreEdge / 6),
    clip((Number(signal.trigger.strength) || 0) / 10, 0, 1),
    clip(1 - triggerAgeMs / triggerWindowMs, 0, 1),
    clip((signal.confirmingTimeframes || []).length / expectedExecution, 0, 1),
    clip((signal.opposingTimeframes || []).length / expectedExecution, 0, 1),
    directionalMean('trend'),
    directionalMean('momentum'),
    directionalMean('structure'),
    directionalMean('volume'),
    mean(execution.map((analysis) => clip(((Number(analysis.rsi) || 50) - 50) / 25) * sign)),
    mean(execution.map((analysis) => clip(((Number(analysis.rangePosition) || 0.5) - 0.5) * 2) * sign)),
    mean(execution.map((analysis) => clip((Number(analysis.distanceFromEma20Atr) || 0) / 2.2) * sign)),
    mean(execution.map((analysis) => clip((Number(analysis.atrPct) || 0) / 2, 0, 1))),
    mean(execution.map((analysis) => clip(Math.log2(Math.max(0.25, Number(analysis.volumeRatio) || 1)) / 2))),
    mean(execution.map((analysis) => clip((Number(analysis.trendStrengthPct) || 0) / 0.5, 0, 1))),
    context.length ? mean(context.map((analysis) => directionValue(analysis.trend, direction))) : 0,
  ].map((value) => round(clip(value), 8));
  if (features.length !== FEATURE_NAMES.length || features.some((value) => !Number.isFinite(value))) {
    throw new Error('local learner produced an invalid feature vector');
  }
  return features;
}

function freshBucket(symbol, horizonMin) {
  return {
    key: bucketKey(symbol, horizonMin),
    symbol,
    horizonMin,
    featureSchemaVersion: FEATURE_SCHEMA_VERSION,
    weights: new Array(FEATURE_NAMES.length + 1).fill(0),
    effectiveSamples: 0,
    wins: 0,
    losses: 0,
    modelLogLossSum: 0,
    baselineLogLossSum: 0,
    lastTrainingTargetCloseTime: null,
    updatedAt: null,
  };
}

function freshState() {
  return {
    schemaVersion: STORAGE_SCHEMA_VERSION,
    policyVersion: POLICY_VERSION,
    featureSchemaVersion: FEATURE_SCHEMA_VERSION,
    algorithmVersion: ALGORITHM_VERSION,
    labelPolicy: LABEL_POLICY,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    buckets: {},
    observations: [],
  };
}

function validLoadedState(value) {
  return Boolean(value && value.schemaVersion === STORAGE_SCHEMA_VERSION
    && value.policyVersion === POLICY_VERSION
    && value.featureSchemaVersion === FEATURE_SCHEMA_VERSION
    && value.algorithmVersion === ALGORITHM_VERSION
    && value.labelPolicy === LABEL_POLICY
    && value.buckets && typeof value.buckets === 'object' && !Array.isArray(value.buckets)
    && Array.isArray(value.observations));
}

class LocalAdaptiveLearner {
  constructor(filePath, { now = () => Date.now() } = {}) {
    this.filePath = filePath;
    this.now = now;
    this.lastError = null;
    this.loadError = null;
    this.persistenceError = null;
    this.available = true;
    this.state = this.load();
  }

  load() {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
      if (!validLoadedState(parsed)) throw new Error('schema/version mismatch');
      for (const bucket of Object.values(parsed.buckets)) {
        if (!Array.isArray(bucket.weights) || bucket.weights.length !== FEATURE_NAMES.length + 1
          || bucket.weights.some((weight) => !Number.isFinite(weight))) throw new Error(`invalid weights in ${bucket.key || 'bucket'}`);
      }
      for (const observation of parsed.observations) {
        if (!observation || typeof observation !== 'object'
          || !Array.isArray(observation.features) || observation.features.length !== FEATURE_NAMES.length
          || observation.features.some((feature) => !Number.isFinite(feature))
          || !Number.isFinite(observation.modelProbabilityAtObservation)
          || !Number.isFinite(observation.baselineProbabilityAtObservation)) {
          throw new Error(`invalid observation ${observation && observation.id || 'unknown'}`);
        }
      }
      return parsed;
    } catch (error) {
      if (error.code === 'ENOENT') return freshState();
      this.loadError = `persisted store is unreadable: ${error.message}`;
      this.lastError = this.loadError;
      this.available = false;
      console.error(`[local-learning] ${this.loadError}; ENTER will remain blocked until the file is repaired or removed and the app is restarted`);
      return freshState();
    }
  }

  persistState(value) {
    value.updatedAt = this.now();
    try {
      atomicWriteJson(this.filePath, value);
      this.persistenceError = null;
      if (!this.loadError) {
        this.available = true;
        this.lastError = null;
      }
    } catch (error) {
      this.persistenceError = `persistence failed: ${error.message}`;
      this.lastError = this.persistenceError;
      this.available = false;
      throw new Error(this.persistenceError);
    }
  }

  save() {
    this.persistState(this.state);
  }

  tryRecoverPersistence() {
    if (this.loadError) return false;
    if (!this.persistenceError) return this.available;
    try {
      this.persistState(this.state);
      return true;
    } catch {
      return false;
    }
  }

  assertAvailable() {
    if (!this.tryRecoverPersistence()) throw new Error(`LOCAL_LEARNER_UNAVAILABLE: ${this.lastError || 'unknown persistence error'}`);
  }

  ensureBucket(symbol, horizonMin) {
    const key = bucketKey(symbol, horizonMin);
    if (!this.state.buckets[key]) this.state.buckets[key] = freshBucket(symbol, horizonMin);
    return this.state.buckets[key];
  }

  predict(bucket, features) {
    const linear = bucket.weights.slice(1).reduce((total, weight, index) => total + weight * features[index], bucket.weights[0]);
    return sigmoid(linear);
  }

  qualification(bucket) {
    const n = Number(bucket.effectiveSamples) || 0;
    const modelLogLoss = n ? bucket.modelLogLossSum / n : null;
    const baselineLogLoss = n ? bucket.baselineLogLossSum / n : null;
    const enoughSamples = n >= MINIMUM_EFFECTIVE_SAMPLE;
    const enoughClasses = bucket.wins >= MINIMUM_CLASS_SAMPLE && bucket.losses >= MINIMUM_CLASS_SAMPLE;
    const beatsBaseline = n > 0 && Number.isFinite(modelLogLoss) && Number.isFinite(baselineLogLoss)
      && modelLogLoss + MINIMUM_LOG_LOSS_EDGE < baselineLogLoss;
    const active = enoughSamples && enoughClasses && beatsBaseline;
    return {
      phase: active ? 'ACTIVE' : enoughSamples && enoughClasses ? 'MONITORING' : 'WARMUP',
      active,
      enoughSamples,
      enoughClasses,
      beatsBaseline,
      modelLogLoss: round(modelLogLoss),
      baselineLogLoss: round(baselineLogLoss),
    };
  }

  overlapsTrainingObservation(key, timing) {
    return this.state.observations.some((observation) => observation.bucketKey === key
      && observation.trainingEligible === true
      && observation.status !== 'invalid'
      && Number(observation.entryOpenTime) <= timing.expiryCloseTime
      && Number(observation.targetCloseTime) >= timing.entryOpenTime);
  }

  observeAndGuard(signal, payout, availableAt) {
    const currentTiming = contractBoundaries(availableAt, Number(signal.horizonMin));
    const withTiming = (timingAvailableAt, timing) => ({
      ...signal,
      generatedAt: timingAvailableAt,
      entryBoundaryOpenTime: timing.entryOpenTime,
      expiryEstimateCloseTime: timing.expiryCloseTime,
    });
    if (signal.action !== 'ENTER' || !signal.signalKey || !['UP', 'DOWN'].includes(signal.direction)) {
      return {
        ...withTiming(availableAt, currentTiming),
        localLearning: { considered: false, phase: 'NOT_A_CANDIDATE', blocked: false },
      };
    }

    const key = bucketKey(signal.symbol, signal.horizonMin);
    if (!this.tryRecoverPersistence()) {
      const detail = `learnerul local nu poate garanta persistența: ${this.lastError || 'eroare necunoscută'}`;
      return {
        ...withTiming(availableAt, currentTiming),
        intendedDirection: signal.direction,
        action: 'WAIT',
        direction: null,
        verdict: 'WAIT',
        signalKey: null,
        localLearning: {
          considered: true,
          bucketKey: key,
          phase: 'ERROR',
          active: false,
          blocked: true,
          error: this.lastError,
          rule: 'orice eroare de încărcare/persistență blochează ENTER până la recuperare explicită',
        },
        reasonCodes: [...new Set([...(signal.reasonCodes || []), 'LOCAL_LEARNER_UNAVAILABLE'])],
        gateChecks: [...(signal.gateChecks || []), { code: 'LOCAL_LEARNER_UNAVAILABLE', pass: false, detail }],
        conflicts: [...(signal.conflicts || []), detail],
      };
    }
    const bucket = this.ensureBucket(signal.symbol, Number(signal.horizonMin));
    const observationId = `${POLICY_VERSION}|${signal.signalKey}`;
    let observation = this.state.observations.find((item) => item.id === observationId);
    if (!observation) {
      const features = extractFeatures(signal);
      const probability = this.predict(bucket, features);
      const baselineProbability = (bucket.wins + 1) / (bucket.effectiveSamples + 2);
      const qualification = this.qualification(bucket);
      const numericPayout = Number(payout);
      const breakEvenProbability = Number.isFinite(numericPayout) && numericPayout > 0 ? 1 / (1 + numericPayout) : null;
      const threshold = Number.isFinite(breakEvenProbability) ? breakEvenProbability + SAFETY_MARGIN : null;
      const blocked = qualification.active && Number.isFinite(threshold) && probability < threshold;
      const lastTarget = Number(bucket.lastTrainingTargetCloseTime);
      const previousWindowComplete = !Number.isFinite(lastTarget) || currentTiming.entryOpenTime > lastTarget;
      const trainingEligible = previousWindowComplete && !this.overlapsTrainingObservation(key, currentTiming);
      observation = {
        id: observationId,
        signalKey: signal.signalKey,
        engineVersion: signal.engineVersion,
        symbol: signal.symbol,
        horizonMin: Number(signal.horizonMin),
        direction: signal.direction,
        bucketKey: key,
        featureSchemaVersion: FEATURE_SCHEMA_VERSION,
        features,
        quality: signal.quality,
        setupFingerprint: signal.setupFingerprint,
        trigger: signal.trigger ? {
          type: signal.trigger.type,
          timeframe: signal.trigger.timeframe,
          strength: signal.trigger.strength,
          closeTime: signal.trigger.closeTime,
        } : null,
        observedAt: availableAt,
        entryOpenTime: currentTiming.entryOpenTime,
        targetCloseTime: currentTiming.expiryCloseTime,
        entryPrice: null,
        exitPrice: null,
        status: 'pending',
        invalidReason: null,
        label: null,
        win: null,
        signedMovePct: null,
        trainingEligible,
        exclusionReason: trainingEligible ? null : 'OVERLAPPING_TRAINING_WINDOW',
        payoutAtObservation: Number.isFinite(numericPayout) ? numericPayout : null,
        modelProbabilityAtObservation: round(probability),
        baselineProbabilityAtObservation: round(baselineProbability),
        breakEvenProbabilityAtObservation: round(breakEvenProbability),
        thresholdAtObservation: round(threshold),
        phaseAtObservation: qualification.phase,
        modelActiveAtObservation: qualification.active,
        blockedAtObservation: blocked,
        effectiveSamplesAtObservation: bucket.effectiveSamples,
        winsAtObservation: bucket.wins,
        lossesAtObservation: bucket.losses,
        beatsBaselineAtObservation: qualification.beatsBaseline,
        trainedAt: null,
      };
      const nextState = {
        ...this.state,
        observations: [...this.state.observations, observation],
      };
      this.persistState(nextState);
      this.state = nextState;
    }

    const timing = {
      entryOpenTime: observation.entryOpenTime,
      expiryCloseTime: observation.targetCloseTime,
    };
    const probability = observation.modelProbabilityAtObservation;
    const threshold = observation.thresholdAtObservation;
    const blocked = observation.blockedAtObservation === true;
    const localLearning = {
      considered: true,
      observationId,
      bucketKey: key,
      phase: observation.phaseAtObservation,
      active: observation.modelActiveAtObservation === true,
      blocked,
      probability,
      threshold,
      breakEvenProbability: observation.breakEvenProbabilityAtObservation,
      effectiveSamples: observation.effectiveSamplesAtObservation,
      minimumEffectiveSamples: MINIMUM_EFFECTIVE_SAMPLE,
      wins: observation.winsAtObservation,
      losses: observation.lossesAtObservation,
      beatsBaseline: observation.beatsBaselineAtObservation === true,
      trainingEligible: observation.trainingEligible,
      exclusionReason: observation.exclusionReason,
      rule: 'poate doar păstra ENTER sau transforma ENTER în WAIT; nu creează și nu inversează semnale',
    };
    const retimed = withTiming(observation.observedAt, timing);
    if (!blocked) return { ...retimed, localLearning };
    const detail = `probabilitate locală ${round(probability * 100, 2)}% sub pragul fix ${round(threshold * 100, 2)}%`;
    return {
      ...retimed,
      intendedDirection: observation.direction,
      action: 'WAIT',
      direction: null,
      verdict: 'WAIT',
      signalKey: null,
      localLearning,
      reasonCodes: [...new Set([...(signal.reasonCodes || []), 'LOCAL_MODEL_BELOW_PAYOUT_THRESHOLD'])],
      gateChecks: [...(signal.gateChecks || []), { code: 'LOCAL_MODEL_BELOW_PAYOUT_THRESHOLD', pass: false, detail }],
      conflicts: [...(signal.conflicts || []), detail],
    };
  }

  train(bucket, observation) {
    const label = Number(observation.label);
    const prequentialPrediction = Number(observation.modelProbabilityAtObservation);
    const prequentialBaseline = Number(observation.baselineProbabilityAtObservation);
    if (!Number.isFinite(prequentialPrediction) || !Number.isFinite(prequentialBaseline)) {
      throw new Error(`observation ${observation.id} is missing prequential probabilities`);
    }
    const updatePrediction = this.predict(bucket, observation.features);
    bucket.modelLogLossSum += logLoss(prequentialPrediction, label);
    bucket.baselineLogLossSum += logLoss(prequentialBaseline, label);
    const error = label - updatePrediction;
    bucket.weights[0] = clip(bucket.weights[0] + LEARNING_RATE * error, -MAX_ABS_WEIGHT, MAX_ABS_WEIGHT);
    for (let index = 0; index < observation.features.length; index += 1) {
      const regularized = bucket.weights[index + 1] * (1 - LEARNING_RATE * L2_PENALTY);
      bucket.weights[index + 1] = clip(regularized + LEARNING_RATE * error * observation.features[index], -MAX_ABS_WEIGHT, MAX_ABS_WEIGHT);
    }
    bucket.effectiveSamples += 1;
    if (label === 1) bucket.wins += 1;
    else bucket.losses += 1;
    bucket.lastTrainingTargetCloseTime = observation.targetCloseTime;
    bucket.updatedAt = this.now();
    observation.prequentialModelProbability = round(prequentialPrediction);
    observation.prequentialBaselineProbability = round(prequentialBaseline);
    observation.trainingModelProbability = round(updatePrediction);
    observation.modelLogLoss = round(logLoss(prequentialPrediction, label));
    observation.baselineLogLoss = round(logLoss(prequentialBaseline, label));
    observation.trainedAt = this.now();
  }

  resolveFromClosedCandles(candlesBySymbol) {
    this.assertAvailable();
    const durableState = this.state;
    const candidateState = cloneState(durableState);
    this.state = candidateState;
    try {
      const resolved = [];
      let changed = false;
      const pending = this.state.observations
        .filter((observation) => observation.status === 'pending')
        .sort((a, b) => Number(a.targetCloseTime) - Number(b.targetCloseTime) || Number(a.observedAt) - Number(b.observedAt));
      for (const observation of pending) {
        const candles = candlesBySymbol[observation.symbol] || [];
        if (!candles.length) continue;
        const boundary = boundaryState(candles, {
          entryOpenTime: observation.entryOpenTime,
          expiryCloseTime: observation.targetCloseTime,
        });
        if (boundary.status === 'invalid') {
          observation.status = 'invalid';
          observation.invalidReason = boundary.reason;
          changed = true;
          continue;
        }
        if (boundary.entry && observation.entryPrice == null) {
          observation.entryPrice = Number(boundary.entry.open);
          changed = true;
        }
        if (boundary.status !== 'complete') continue;
        observation.exitPrice = Number(boundary.exit.close);
        observation.exitCloseTime = Number(boundary.exit.closeTime);
        observation.label = observation.direction === 'UP'
          ? Number(observation.exitPrice > observation.entryPrice)
          : Number(observation.exitPrice < observation.entryPrice);
        observation.win = observation.label === 1;
        observation.signedMovePct = observation.entryPrice > 0
          ? round(((observation.exitPrice - observation.entryPrice) / observation.entryPrice) * 100
            * (observation.direction === 'UP' ? 1 : -1), 6) : null;
        observation.status = 'resolved';
        observation.resolvedAt = this.now();
        if (observation.trainingEligible && !observation.trainedAt) {
          this.train(this.ensureBucket(observation.symbol, observation.horizonMin), observation);
        }
        changed = true;
        resolved.push(observation);
      }
      if (changed) this.save();
      return resolved;
    } catch (error) {
      this.state = durableState;
      throw error;
    }
  }

  snapshot(symbols = ['BTCUSDT', 'ETHUSDT'], horizons = [10, 30]) {
    for (const symbol of symbols) for (const horizon of horizons) this.ensureBucket(symbol, horizon);
    const byBucket = {};
    for (const [key, bucket] of Object.entries(this.state.buckets)) {
      const observations = this.state.observations.filter((item) => item.bucketKey === key);
      const qualification = this.qualification(bucket);
      const reportedQualification = this.available ? qualification : { ...qualification, phase: 'ERROR', active: false };
      byBucket[key] = {
        key,
        symbol: bucket.symbol,
        horizonMin: bucket.horizonMin,
        phase: reportedQualification.phase,
        active: reportedQualification.active,
        effectiveSamples: bucket.effectiveSamples,
        minimumEffectiveSamples: MINIMUM_EFFECTIVE_SAMPLE,
        wins: bucket.wins,
        losses: bucket.losses,
        pending: observations.filter((item) => item.status === 'pending').length,
        resolved: observations.filter((item) => item.status === 'resolved').length,
        invalid: observations.filter((item) => item.status === 'invalid').length,
        excludedOverlap: observations.filter((item) => item.trainingEligible === false).length,
        modelLogLoss: qualification.modelLogLoss,
        baselineLogLoss: qualification.baselineLogLoss,
        beatsBaseline: qualification.beatsBaseline,
        lastTrainingTargetCloseTime: bucket.lastTrainingTargetCloseTime,
      };
    }
    return {
      enabled: true,
      available: this.available,
      externalApi: false,
      estimatedApiCost: 0,
      policyVersion: POLICY_VERSION,
      algorithmVersion: ALGORITHM_VERSION,
      featureSchemaVersion: FEATURE_SCHEMA_VERSION,
      featureCount: FEATURE_NAMES.length,
      labelPolicy: LABEL_POLICY,
      policy: 'shadow walk-forward; numai observații ne-suprapuse antrenează; modelul poate doar bloca un ENTER determinist',
      retention: 'append-only; observațiile nu sunt trunchiate automat',
      recovery: this.loadError ? 'Șterge sau repară desktop/data/local-learning.json, apoi repornește aplicația.' : null,
      activation: {
        minimumEffectiveSamples: MINIMUM_EFFECTIVE_SAMPLE,
        minimumWins: MINIMUM_CLASS_SAMPLE,
        minimumLosses: MINIMUM_CLASS_SAMPLE,
        mustBeatNaiveBaseline: true,
        payoutSafetyMarginPercentagePoints: SAFETY_MARGIN * 100,
      },
      totals: {
        observations: this.state.observations.length,
        pending: this.state.observations.filter((item) => item.status === 'pending').length,
        resolved: this.state.observations.filter((item) => item.status === 'resolved').length,
        invalid: this.state.observations.filter((item) => item.status === 'invalid').length,
        effectiveSamples: Object.values(this.state.buckets).reduce((total, bucket) => total + bucket.effectiveSamples, 0),
        excludedOverlap: this.state.observations.filter((item) => item.trainingEligible === false).length,
      },
      byBucket,
      lastError: this.lastError,
      updatedAt: this.state.updatedAt,
    };
  }
}

module.exports = {
  LocalAdaptiveLearner,
  FEATURE_NAMES,
  FEATURE_SCHEMA_VERSION,
  ALGORITHM_VERSION,
  POLICY_VERSION,
  LABEL_POLICY,
  MINIMUM_EFFECTIVE_SAMPLE,
  MINIMUM_CLASS_SAMPLE,
  SAFETY_MARGIN,
  bucketKey,
  extractFeatures,
  sigmoid,
  logLoss,
};
