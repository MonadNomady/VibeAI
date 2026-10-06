/**
 * Browser client and display helpers for the optional DistilRoBERTa emotion
 * model. Importing this module is safe in Node: the Web Worker is created only
 * when classifyEmotions() is called.
 */

export const EMOTION_LABELS = Object.freeze([
  "anger",
  "disgust",
  "fear",
  "joy",
  "neutral",
  "sadness",
  "surprise",
]);

export const EMOTION_MODEL_ID = "onnx-community/emotion-english-distilroberta-base-ONNX";
export const EMOTION_MODEL_REVISION = "f4407dc20b99ae081ab2e4f089595e70c1609f59";
export const TRANSFORMERS_JS_VERSION = "4.3.0";

const pendingRequests = new Map();
let emotionWorker = null;
let requestSequence = 0;

function emptyScores() {
  return Object.fromEntries(EMOTION_LABELS.map((label) => [label, 0]));
}

function normalizedLabel(value) {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

function addScore(scores, label, value) {
  const key = normalizedLabel(label);
  const score = Number(value);
  if (!Object.hasOwn(scores, key) || !Number.isFinite(score) || score <= 0) return;

  // A valid model response has one entry per label. Keeping the largest value
  // makes malformed duplicate entries deterministic without double-counting.
  scores[key] = Math.max(scores[key], score);
}

/**
 * Convert model output (or an existing score map) into the seven known labels
 * in a stable order. Valid positive values are re-normalized to sum to one.
 */
export function normalizeEmotionScores(rawScores) {
  const scores = emptyScores();
  let source = rawScores;

  // Python-style pipelines sometimes wrap one input's result in an extra
  // array. Accepting that shape makes this boundary resilient and testable.
  if (Array.isArray(source) && source.length === 1 && Array.isArray(source[0])) {
    [source] = source;
  }

  if (Array.isArray(source)) {
    for (const entry of source) {
      if (!entry || typeof entry !== "object") continue;
      addScore(scores, entry.label, entry.score);
    }
  } else if (source && typeof source === "object") {
    const scoreMap = source.scores && typeof source.scores === "object"
      ? source.scores
      : source;
    for (const [label, score] of Object.entries(scoreMap)) addScore(scores, label, score);
  }

  const total = Object.values(scores).reduce((sum, score) => sum + score, 0);
  if (total > 0) {
    for (const label of EMOTION_LABELS) scores[label] /= total;
  }

  return Object.freeze(scores);
}

/** Return the highest-scoring label, or null when every score is zero. */
export function getDominantEmotion(rawScores) {
  const scores = normalizeEmotionScores(rawScores);
  let dominant = null;

  for (const label of EMOTION_LABELS) {
    if (!dominant || scores[label] > dominant.score) {
      dominant = { label, score: scores[label] };
    }
  }

  return dominant && dominant.score > 0 ? Object.freeze(dominant) : null;
}

function positiveNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

function pointAt(centerX, centerY, distance, angle) {
  return {
    x: centerX + Math.cos(angle) * distance,
    y: centerY + Math.sin(angle) * distance,
  };
}

/** Convert radar points to the value accepted by an SVG polygon element. */
export function formatRadarPoints(points, precision = 2) {
  const digits = Math.min(6, Math.max(0, Math.trunc(Number(precision) || 0)));
  if (!Array.isArray(points)) return "";

  return points
    .filter((point) => Number.isFinite(point?.x) && Number.isFinite(point?.y))
    .map(({ x, y }) => {
      const safeX = Math.abs(x) < 10 ** -digits ? 0 : x;
      const safeY = Math.abs(y) < 10 ** -digits ? 0 : y;
      return `${safeX.toFixed(digits)},${safeY.toFixed(digits)}`;
    })
    .join(" ");
}

/**
 * Build all geometry needed for an accessible SVG radar chart. The first axis
 * points upward and the remaining labels proceed clockwise.
 */
export function buildRadarGeometry(rawScores, options = {}) {
  const width = positiveNumber(options.width, 320);
  const height = positiveNumber(options.height, 280);
  const centerX = Number.isFinite(Number(options.centerX)) ? Number(options.centerX) : width / 2;
  const centerY = Number.isFinite(Number(options.centerY)) ? Number(options.centerY) : height / 2;
  const maximumRadius = Math.max(1, Math.min(width, height) / 2);
  const defaultRadius = Math.max(1, maximumRadius - 34);
  const radius = Math.min(positiveNumber(options.radius, defaultRadius), maximumRadius);
  const levelCount = Math.min(10, Math.max(1, Math.trunc(positiveNumber(options.levels, 4))));
  const startAngle = Number.isFinite(Number(options.startAngle))
    ? Number(options.startAngle)
    : -Math.PI / 2;
  const labelOffset = Number.isFinite(Number(options.labelOffset))
    ? Math.max(0, Number(options.labelOffset))
    : 18;
  const scores = normalizeEmotionScores(rawScores);
  const angleStep = (Math.PI * 2) / EMOTION_LABELS.length;

  const axes = EMOTION_LABELS.map((label, index) => {
    const angle = startAngle + angleStep * index;
    const endpoint = pointAt(centerX, centerY, radius, angle);
    const labelPoint = pointAt(centerX, centerY, radius + labelOffset, angle);
    return Object.freeze({ label, angle, ...endpoint, labelX: labelPoint.x, labelY: labelPoint.y });
  });

  const points = axes.map(({ label, angle }) => {
    const value = scores[label];
    return Object.freeze({ label, value, angle, ...pointAt(centerX, centerY, radius * value, angle) });
  });

  const rings = Array.from({ length: levelCount }, (_, index) => {
    const value = (index + 1) / levelCount;
    const ringPoints = axes.map(({ angle }) => pointAt(centerX, centerY, radius * value, angle));
    return Object.freeze({ value, points: formatRadarPoints(ringPoints) });
  });

  return Object.freeze({
    width,
    height,
    viewBox: `0 0 ${width} ${height}`,
    centerX,
    centerY,
    radius,
    scores,
    axes: Object.freeze(axes),
    points: Object.freeze(points),
    polygon: formatRadarPoints(points),
    rings: Object.freeze(rings),
  });
}

function createAbortError() {
  const error = new Error("Emotion classification was cancelled.");
  error.name = "AbortError";
  return error;
}

function errorFromWorker(payload) {
  const error = new Error(
    typeof payload?.message === "string" && payload.message
      ? payload.message
      : "The emotion model could not classify this sentence.",
  );
  if (typeof payload?.name === "string" && payload.name) error.name = payload.name;
  return error;
}

function safelyReportProgress(callback, message) {
  if (typeof callback !== "function") return;
  try {
    callback(Object.freeze({
      progress: Math.min(100, Math.max(0, Number(message.progress) || 0)),
      loaded: Number.isFinite(Number(message.loaded)) ? Number(message.loaded) : null,
      total: Number.isFinite(Number(message.total)) ? Number(message.total) : null,
    }));
  } catch {
    // A display callback must not be able to interrupt model inference.
  }
}

function handleWorkerMessage(event) {
  const message = event?.data;
  if (!message || typeof message !== "object") return;

  const request = pendingRequests.get(message.requestId);
  if (!request) return;

  if (message.type === "progress") {
    safelyReportProgress(request.onProgress, message);
  } else if (message.type === "result") {
    request.resolve(normalizeEmotionScores(message.scores));
  } else if (message.type === "error") {
    request.reject(errorFromWorker(message.error));
  }
}

function failWorker(event) {
  const error = event?.error instanceof Error
    ? event.error
    : new Error(event?.message || "The browser emotion model stopped unexpectedly.");
  disposeEmotionModel(error);
}

function defaultWorkerFactory() {
  if (typeof Worker !== "function") {
    throw new Error("Emotion classification requires a browser with Web Worker support.");
  }
  return new Worker(new URL("./emotion-worker.js", import.meta.url), {
    type: "module",
    name: "vibecheck-emotion-model",
  });
}

function getEmotionWorker(workerFactory) {
  if (emotionWorker) return emotionWorker;

  const worker = (workerFactory ?? defaultWorkerFactory)();
  if (!worker || typeof worker.postMessage !== "function" || typeof worker.addEventListener !== "function") {
    throw new TypeError("The emotion worker factory did not return a valid Worker.");
  }

  worker.addEventListener("message", handleWorkerMessage);
  worker.addEventListener("error", failWorker);
  worker.addEventListener("messageerror", failWorker);
  emotionWorker = worker;
  return emotionWorker;
}

/**
 * Classify one English sentence in the browser.
 *
 * Resolves to a frozen object with all seven EMOTION_LABELS as keys. The model
 * loads lazily on the first call and is shared by later calls.
 */
export function classifyEmotions(sentence, options = {}) {
  if (typeof sentence !== "string" || !sentence.trim()) {
    return Promise.reject(new TypeError("Please provide a sentence to classify."));
  }
  if (options.signal?.aborted) return Promise.reject(createAbortError());

  let worker;
  try {
    worker = getEmotionWorker(options.workerFactory);
  } catch (error) {
    return Promise.reject(error);
  }

  const requestId = `emotion-${++requestSequence}`;
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      pendingRequests.delete(requestId);
      options.signal?.removeEventListener("abort", abortRequest);
      callback(value);
    };
    const abortRequest = () => {
      try {
        worker.postMessage({ type: "cancel", requestId });
      } catch {
        // The local promise can still be cancelled if the worker already died.
      }
      finish(reject, createAbortError());
    };

    pendingRequests.set(requestId, {
      onProgress: options.onProgress,
      resolve: (scores) => finish(resolve, scores),
      reject: (error) => finish(reject, error),
    });
    options.signal?.addEventListener("abort", abortRequest, { once: true });

    try {
      worker.postMessage({ type: "classify", requestId, text: sentence.trim() });
    } catch (error) {
      finish(reject, error);
    }
  });
}

/** Release the browser worker and reject requests that are still pending. */
export function disposeEmotionModel(reason = new Error("The emotion model was closed.")) {
  const worker = emotionWorker;
  emotionWorker = null;

  for (const request of [...pendingRequests.values()]) request.reject(reason);
  pendingRequests.clear();

  if (worker && typeof worker.terminate === "function") worker.terminate();
}
