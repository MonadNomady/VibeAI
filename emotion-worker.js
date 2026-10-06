import {
  env,
  pipeline,
} from "https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.3.0";
import {
  EMOTION_MODEL_ID,
  EMOTION_MODEL_REVISION,
} from "./emotion-model.js";

env.allowLocalModels = false;
env.useBrowserCache = true;
env.useWasmCache = true;

const activeRequestIds = new Set();
const cancelledRequestIds = new Set();
let classifierPromise = null;
let workQueue = Promise.resolve();
let latestProgress = null;

function serializeError(error) {
  return {
    name: error instanceof Error && error.name ? error.name : "Error",
    message: error instanceof Error && error.message
      ? error.message
      : "The emotion model could not classify this sentence.",
  };
}

function sendProgress(requestId) {
  if (!latestProgress || cancelledRequestIds.has(requestId)) return;
  self.postMessage({ type: "progress", requestId, ...latestProgress });
}

function handleModelProgress(info) {
  if (info?.status !== "progress_total") return;

  latestProgress = {
    progress: Math.min(100, Math.max(0, Number(info.progress) || 0)),
    loaded: Number.isFinite(Number(info.loaded)) ? Number(info.loaded) : null,
    total: Number.isFinite(Number(info.total)) ? Number(info.total) : null,
  };
  for (const requestId of activeRequestIds) sendProgress(requestId);
}

function getClassifier() {
  if (!classifierPromise) {
    latestProgress = null;
    classifierPromise = pipeline("text-classification", EMOTION_MODEL_ID, {
      revision: EMOTION_MODEL_REVISION,
      device: "wasm",
      dtype: "q8",
      progress_callback: handleModelProgress,
    }).then((classifier) => {
      latestProgress = { progress: 100, loaded: null, total: null };
      for (const requestId of activeRequestIds) sendProgress(requestId);
      return classifier;
    }).catch((error) => {
      // A later request should get a fresh download/load attempt.
      classifierPromise = null;
      latestProgress = null;
      throw error;
    });
  }

  return classifierPromise;
}

async function classifyRequest({ requestId, text }) {
  if (cancelledRequestIds.has(requestId)) {
    cancelledRequestIds.delete(requestId);
    activeRequestIds.delete(requestId);
    return;
  }

  try {
    const classifier = await getClassifier();
    if (cancelledRequestIds.has(requestId)) return;

    const scores = await classifier(text, { top_k: null });
    if (!cancelledRequestIds.has(requestId)) {
      self.postMessage({ type: "result", requestId, scores });
    }
  } catch (error) {
    if (!cancelledRequestIds.has(requestId)) {
      self.postMessage({ type: "error", requestId, error: serializeError(error) });
    }
  } finally {
    activeRequestIds.delete(requestId);
    cancelledRequestIds.delete(requestId);
  }
}

self.addEventListener("message", (event) => {
  const message = event?.data;
  if (!message || typeof message !== "object" || typeof message.requestId !== "string") return;

  if (message.type === "cancel") {
    if (activeRequestIds.has(message.requestId)) {
      cancelledRequestIds.add(message.requestId);
      activeRequestIds.delete(message.requestId);
    }
    return;
  }

  if (message.type !== "classify") return;

  if (typeof message.text !== "string" || !message.text.trim()) {
    self.postMessage({
      type: "error",
      requestId: message.requestId,
      error: { name: "TypeError", message: "Please provide a sentence to classify." },
    });
    return;
  }

  activeRequestIds.add(message.requestId);
  sendProgress(message.requestId);

  // A single ONNX session is shared, while inference requests are kept in
  // order so low-memory classroom devices do not run several passes at once.
  workQueue = workQueue.then(
    () => classifyRequest({ requestId: message.requestId, text: message.text.trim() }),
    () => classifyRequest({ requestId: message.requestId, text: message.text.trim() }),
  );
});
