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
const LOSS_STREAK_LIMIT = 3;
const RECOVERY_WINDOW = 5;
const SETUP_GUARD_SAMPLE = 12;
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

function wilsonUpperProbability(wins, sample) {
  if (!sample) return null;
  const z = 1.959963984540054;
  const probability = wins / sample;
  const denominator = 1 + (z * z) / sample;
  const center = (probability + (z * z) / (2 * sample)) / denominator;
  const margin = z * Math.sqrt((probability * (1 - probability) + (z * z) / (4 * sample)) / sample) / denominator;
  return Math.min(1, center + margin);
}

function requiredRecoveryWinsForThreshold(threshold) {
  if (!Number.isFinite(threshold)) return RECOVERY_WINDOW;
  return Math.max(1, Math.ceil(threshold * RECOVERY_WINDOW));
}

function freshCircuit() {
  return {
    open: false,
    openedAt: null,
    triggerObservationId: null,
    recoveryLabels: [],
    recoveryEvaluated: 0,
    lastClosedAt: null,
    lastRecovery: null,
  };
}

function normalizeBucket(bucket) {
  if (!Number.isInteger(bucket.allowedLossStreak) || bucket.allowedLossStreak < 0) bucket.allowedLossStreak = 0;
  if (!bucket.circuit || typeof bucket.circuit !== 'object' || Array.isArray(bucket.circuit)) bucket.circuit = freshCircuit();
  bucket.circuit = { ...freshCircuit(), ...bucket.circuit };
  if (!Array.isArray(bucket.circuit.recoveryLabels)) bucket.circuit.recoveryLabels = [];
  bucket.circuit.recoveryLabels = bucket.circuit.recoveryLabels.filter((label) => label === 0 || label === 1).slice(-RECOVERY_WINDOW);
  return bucket;
}

function rebuildOperationalBucket(bucket, observations) {
  normalizeBucket(bucket);
  bucket.allowedLossStreak = 0;
  bucket.circuit = freshCircuit();
  const allowedResolved = observations
    .filter((observation) => observation.bucketKey === bucket.key
      && observation.status === 'resolved'
      && observation.blockedAtObservation !== true
      && (observation.label === 0 || observation.label === 1))
    .sort((a, b) => Number(a.targetCloseTime) - Number(b.targetCloseTime));
  for (const observation of allowedResolved) {
    bucket.allowedLossStreak = observation.label === 0 ? bucket.allowedLossStreak + 1 : 0;
  }
  if (bucket.allowedLossStreak >= LOSS_STREAK_LIMIT) {
    const trigger = allowedResolved[allowedResolved.length - 1];
    bucket.circuit.open = true;
    bucket.circuit.openedAt = trigger ? trigger.targetCloseTime : null;
    bucket.circuit.triggerObservationId = trigger ? trigger.id : null;
  }
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
    allowedLossStreak: 0,
    circuit: freshCircuit(),
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
  constructor(filePath, { now = () => Date.now(), adaptiveProtection = false } = {}) {
    this.filePath = filePath;
    this.now = now;
    this.adaptiveProtection = adaptiveProtection === true;
    this.lastError = null;
    this.loadError = null;
    this.persistenceError = null;
    this.operationalMigrationNeeded = false;
    this.available = true;
    this.state = this.load();
    if (this.available && this.operationalMigrationNeeded) {
      try {
        this.persistState(this.state);
      } catch {
        // persistState marks the learner unavailable; candidate ENTER will fail closed.
      }
    }
  }

  load() {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
      if (!validLoadedState(parsed)) throw new Error('schema/version mismatch');
      const bucketsNeedingMigration = [];
      for (const [key, bucket] of Object.entries(parsed.buckets)) {
        if (!Array.isArray(bucket.weights) || bucket.weights.length !== FEATURE_NAMES.length + 1
          || bucket.weights.some((weight) => !Number.isFinite(weight))) throw new Error(`invalid weights in ${bucket.key || 'bucket'}`);
        const hasOperationalState = Number.isInteger(bucket.allowedLossStreak)
          && bucket.circuit && typeof bucket.circuit === 'object' && !Array.isArray(bucket.circuit);
        normalizeBucket(bucket);
        if (this.adaptiveProtection && !hasOperationalState) bucketsNeedingMigration.push(key);
      }
      for (const observation of parsed.observations) {
        if (!observation || typeof observation !== 'object'
          || !Array.isArray(observation.features) || observation.features.length !== FEATURE_NAMES.length
          || observation.features.some((feature) => !Number.isFinite(feature))
          || !Number.isFinite(observation.modelProbabilityAtObservation)
          || !Number.isFinite(observation.baselineProbabilityAtObservation)) {
          throw new Error(`invalid observation ${observation && observation.id || 'unknown'}`);
        }
        if (!Array.isArray(observation.blockReasonsAtObservation)) {
          observation.modelBlockedAtObservation = observation.blockedAtObservation === true;
          observation.lossCircuitBlockedAtObservation = false;
          observation.setupBlockedAtObservation = false;
          observation.blockReasonsAtObservation = observation.blockedAtObservation ? [{
            code: 'LOCAL_MODEL_BELOW_PAYOUT_THRESHOLD',
            detail: 'modelul local a blocat semnalul înaintea politicii adaptive v2',
          }] : [];
        }
      }
      for (const key of bucketsNeedingMigration) rebuildOperationalBucket(parsed.buckets[key], parsed.observations);
      this.operationalMigrationNeeded = bucketsNeedingMigration.length > 0;
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

  setupGuard(bucketKeyValue, setupFingerprint, threshold) {
    const comparable = !setupFingerprint ? [] : this.state.observations
      .filter((observation) => observation.bucketKey === bucketKeyValue
        && observation.setupFingerprint === setupFingerprint
        && observation.status === 'resolved'
        && observation.trainingEligible === true)
      .sort((a, b) => Number(b.targetCloseTime) - Number(a.targetCloseTime))
      .slice(0, SETUP_GUARD_SAMPLE);
    const wins = comparable.filter((observation) => observation.label === 1).length;
    const upper = wilsonUpperProbability(wins, comparable.length);
    const blocked = comparable.length >= SETUP_GUARD_SAMPLE && Number.isFinite(threshold)
      && Number.isFinite(upper) && upper < threshold;
    return {
      setupFingerprint: setupFingerprint || null,
      sample: comparable.length,
      minimumSample: SETUP_GUARD_SAMPLE,
      wins,
      losses: comparable.length - wins,
      winRate: comparable.length ? round(wins / comparable.length) : null,
      wilson95Upper: round(upper),
      threshold: round(threshold),
      blocked,
    };
  }

  updateOperationalGuard(bucket, observation) {
    if (!this.adaptiveProtection) return;
    normalizeBucket(bucket);
    const circuit = bucket.circuit;
    if (circuit.open) {
      if (observation.lossCircuitBlockedAtObservation === true && observation.trainingEligible === true) {
        circuit.recoveryLabels.push(Number(observation.label));
        circuit.recoveryLabels = circuit.recoveryLabels.slice(-RECOVERY_WINDOW);
        circuit.recoveryEvaluated += 1;
        const threshold = Number(observation.thresholdAtObservation);
        const requiredWins = requiredRecoveryWinsForThreshold(threshold);
        const recoveryPossible = requiredWins <= RECOVERY_WINDOW;
        const recoveryWins = circuit.recoveryLabels.reduce((total, label) => total + label, 0);
        const recovered = recoveryPossible && circuit.recoveryLabels.length === RECOVERY_WINDOW && recoveryWins >= requiredWins;
        observation.circuitRecovery = {
          sample: circuit.recoveryLabels.length,
          wins: recoveryWins,
          requiredSample: RECOVERY_WINDOW,
          requiredWins,
          recoveryPossible,
          recovered,
        };
        if (recovered) {
          circuit.open = false;
          circuit.lastClosedAt = observation.targetCloseTime;
          circuit.lastRecovery = { ...observation.circuitRecovery, closedByObservationId: observation.id };
          circuit.openedAt = null;
          circuit.triggerObservationId = null;
          circuit.recoveryLabels = [];
          circuit.recoveryEvaluated = 0;
          bucket.allowedLossStreak = 0;
        }
      }
      return;
    }

    if (observation.blockedAtObservation === true) return;
    bucket.allowedLossStreak = observation.label === 0 ? bucket.allowedLossStreak + 1 : 0;
    observation.allowedLossStreakAfterOutcome = bucket.allowedLossStreak;
    if (bucket.allowedLossStreak >= LOSS_STREAK_LIMIT) {
      circuit.open = true;
      circuit.openedAt = observation.targetCloseTime;
      circuit.triggerObservationId = observation.id;
      circuit.recoveryLabels = [];
      circuit.recoveryEvaluated = 0;
      observation.openedLossCircuit = true;
    }
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
        localLearning: { considered: false, adaptiveProtection: this.adaptiveProtection, phase: 'NOT_A_CANDIDATE', blocked: false },
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
          adaptiveProtection: this.adaptiveProtection,
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
      const modelBlocked = qualification.active && Number.isFinite(threshold) && probability < threshold;
      const circuitBlocked = this.adaptiveProtection && bucket.circuit.open === true;
      const setupGuard = this.setupGuard(key, signal.setupFingerprint, threshold);
      if (!this.adaptiveProtection) setupGuard.blocked = false;
      const requiredRecoveryWins = requiredRecoveryWinsForThreshold(threshold);
      const recoveryPossible = requiredRecoveryWins <= RECOVERY_WINDOW;
      const blockReasons = [];
      if (circuitBlocked) blockReasons.push({
        code: 'LOCAL_LOSS_STREAK_CIRCUIT_OPEN',
        detail: recoveryPossible
          ? `circuit de siguranță deschis după ${LOSS_STREAK_LIMIT} pierderi consecutive; așteaptă ${RECOVERY_WINDOW} rezultate shadow eligibile și minimum ${requiredRecoveryWins} WIN`
          : `circuit de siguranță deschis după ${LOSS_STREAK_LIMIT} pierderi consecutive; pragul payout-ului cere ${requiredRecoveryWins} WIN din ${RECOVERY_WINDOW}, deci recovery nu este posibil până când payout-ul crește`,
      });
      if (setupGuard.blocked) blockReasons.push({
        code: 'LOCAL_SETUP_UNRELIABLE',
        detail: `setup ${setupGuard.setupFingerprint}: ${setupGuard.wins}W/${setupGuard.losses}L din ${setupGuard.sample}, Wilson95 upper ${round(setupGuard.wilson95Upper * 100, 2)}% sub prag ${round(threshold * 100, 2)}%`,
      });
      if (modelBlocked) blockReasons.push({
        code: 'LOCAL_MODEL_BELOW_PAYOUT_THRESHOLD',
        detail: `probabilitate locală ${round(probability * 100, 2)}% sub pragul fix ${round(threshold * 100, 2)}%`,
      });
      const blocked = blockReasons.length > 0;
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
        modelBlockedAtObservation: modelBlocked,
        lossCircuitBlockedAtObservation: circuitBlocked,
        setupBlockedAtObservation: setupGuard.blocked,
        blockedAtObservation: blocked,
        blockReasonsAtObservation: blockReasons,
        setupGuardAtObservation: setupGuard,
        allowedLossStreakAtObservation: bucket.allowedLossStreak,
        lossCircuitAtObservation: {
          open: bucket.circuit.open,
          openedAt: bucket.circuit.openedAt,
          recoverySample: bucket.circuit.recoveryLabels.length,
          recoveryWins: bucket.circuit.recoveryLabels.reduce((total, label) => total + label, 0),
        },
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
      adaptiveProtection: this.adaptiveProtection,
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
      blockReasons: observation.blockReasonsAtObservation || [],
      setupGuard: observation.setupGuardAtObservation || null,
      allowedLossStreak: observation.allowedLossStreakAtObservation || 0,
      lossCircuit: observation.lossCircuitAtObservation || { open: false, recoverySample: 0, recoveryWins: 0 },
      rule: this.adaptiveProtection
        ? `protecție în 3 trepte: circuit după ${LOSS_STREAK_LIMIT} loss, guard setup la N=${SETUP_GUARD_SAMPLE}, apoi model complet; poate doar ENTER→WAIT`
        : 'instanța 3013 păstrează learnerul logistic anterior; protecția rapidă în 3 trepte este izolată pe 3014',
    };
    const retimed = withTiming(observation.observedAt, timing);
    if (!blocked) return { ...retimed, localLearning };
    const blockReasons = localLearning.blockReasons.length ? localLearning.blockReasons : [{
      code: 'LOCAL_ADAPTIVE_GUARD_BLOCKED',
      detail: 'learnerul local a blocat intrarea fără un motiv serializat',
    }];
    return {
      ...retimed,
      intendedDirection: observation.direction,
      action: 'WAIT',
      direction: null,
      verdict: 'WAIT',
      signalKey: null,
      localLearning,
      reasonCodes: [...new Set([...(signal.reasonCodes || []), ...blockReasons.map((reason) => reason.code)])],
      gateChecks: [...(signal.gateChecks || []), ...blockReasons.map((reason) => ({
        code: reason.code,
        pass: false,
        detail: reason.detail,
      }))],
      conflicts: [...(signal.conflicts || []), ...blockReasons.map((reason) => reason.detail)],
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
        const bucket = this.ensureBucket(observation.symbol, observation.horizonMin);
        this.updateOperationalGuard(bucket, observation);
        if (observation.trainingEligible && !observation.trainedAt) {
          this.train(bucket, observation);
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

  snapshot(symbols = ['BTCUSDT', 'ETHUSDT'], payoutByHorizon = {}) {
    for (const symbol of symbols) for (const horizon of [10, 30]) this.ensureBucket(symbol, horizon);
    const byBucket = {};
    for (const [key, bucket] of Object.entries(this.state.buckets)) {
      normalizeBucket(bucket);
      const observations = this.state.observations.filter((item) => item.bucketKey === key);
      const qualification = this.qualification(bucket);
      const reportedQualification = this.available ? qualification : { ...qualification, phase: 'ERROR', active: false };
      const payout = Number(payoutByHorizon[bucket.horizonMin]);
      const threshold = Number.isFinite(payout) && payout > 0 ? 1 / (1 + payout) + SAFETY_MARGIN : null;
      const setupFingerprints = [...new Set(observations.map((item) => item.setupFingerprint).filter(Boolean))];
      const weakSetups = this.adaptiveProtection ? setupFingerprints.map((fingerprint) => this.setupGuard(key, fingerprint, threshold))
        .filter((setup) => setup.blocked)
        .sort((a, b) => a.wilson95Upper - b.wilson95Upper) : [];
      const recoveryWins = bucket.circuit.recoveryLabels.reduce((total, label) => total + label, 0);
      const recoveryRequiredWins = requiredRecoveryWinsForThreshold(threshold);
      const recoveryPossible = recoveryRequiredWins <= RECOVERY_WINDOW;
      byBucket[key] = {
        key,
        symbol: bucket.symbol,
        horizonMin: bucket.horizonMin,
        phase: reportedQualification.phase,
        active: reportedQualification.active,
        adaptiveProtection: this.adaptiveProtection,
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
        allowedLossStreak: bucket.allowedLossStreak,
        lossStreakLimit: LOSS_STREAK_LIMIT,
        circuit: {
          open: bucket.circuit.open,
          openedAt: bucket.circuit.openedAt,
          recoverySample: bucket.circuit.recoveryLabels.length,
          recoveryWins,
          recoveryRequiredSample: RECOVERY_WINDOW,
          recoveryRequiredWins,
          recoveryPossible,
          recoveryEvaluated: bucket.circuit.recoveryEvaluated,
          lastClosedAt: bucket.circuit.lastClosedAt,
          lastRecovery: bucket.circuit.lastRecovery,
        },
        weakSetups,
        lastTrainingTargetCloseTime: bucket.lastTrainingTargetCloseTime,
      };
    }
    return {
      enabled: true,
      available: this.available,
      adaptiveProtection: this.adaptiveProtection,
      externalApi: false,
      estimatedApiCost: 0,
      policyVersion: POLICY_VERSION,
      algorithmVersion: ALGORITHM_VERSION,
      featureSchemaVersion: FEATURE_SCHEMA_VERSION,
      featureCount: FEATURE_NAMES.length,
      labelPolicy: LABEL_POLICY,
      policy: this.adaptiveProtection
        ? `protecție locală în 3 trepte: pauză după ${LOSS_STREAK_LIMIT} loss consecutive, setup guard la N=${SETUP_GUARD_SAMPLE}, model logistic complet la N=${MINIMUM_EFFECTIVE_SAMPLE}`
        : `learner logistic v4 original pe 3013; protecția adaptivă în 3 trepte rulează numai în instanța 3014`,
      retention: 'append-only; observațiile nu sunt trunchiate automat',
      recovery: this.loadError ? 'Șterge sau repară fișierul local-learning.json al instanței, apoi repornește aplicația.' : null,
      activation: {
        lossStreakLimit: LOSS_STREAK_LIMIT,
        recoveryWindow: RECOVERY_WINDOW,
        setupGuardMinimumSample: SETUP_GUARD_SAMPLE,
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
