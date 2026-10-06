import test from "node:test";
import assert from "node:assert/strict";
import {
  EMOTION_LABELS,
  EMOTION_MODEL_ID,
  EMOTION_MODEL_REVISION,
  TRANSFORMERS_JS_VERSION,
  buildRadarGeometry,
  classifyEmotions,
  disposeEmotionModel,
  formatRadarPoints,
  getDominantEmotion,
  normalizeEmotionScores,
} from "../emotion-model.js";

test.afterEach(() => disposeEmotionModel());

test("pins the browser model and exposes the seven labels in model order", () => {
  assert.equal(TRANSFORMERS_JS_VERSION, "4.3.0");
  assert.equal(EMOTION_MODEL_ID, "onnx-community/emotion-english-distilroberta-base-ONNX");
  assert.equal(EMOTION_MODEL_REVISION, "f4407dc20b99ae081ab2e4f089595e70c1609f59");
  assert.deepEqual(EMOTION_LABELS, [
    "anger",
    "disgust",
    "fear",
    "joy",
    "neutral",
    "sadness",
    "surprise",
  ]);
  assert(Object.isFrozen(EMOTION_LABELS));
});

test("normalizes unordered model output into a stable seven-key score map", () => {
  const scores = normalizeEmotionScores([
    { label: "JOY", score: 7 },
    { label: "sadness", score: 2 },
    { label: "neutral", score: 1 },
    { label: "not-a-model-label", score: 500 },
  ]);

  assert.deepEqual(Object.keys(scores), EMOTION_LABELS);
  assert.equal(scores.joy, 0.7);
  assert.equal(scores.sadness, 0.2);
  assert.equal(scores.neutral, 0.1);
  assert.equal(scores.anger, 0);
  assert.equal(Object.values(scores).reduce((sum, value) => sum + value, 0), 1);
  assert(Object.isFrozen(scores));
});

test("normalization accepts wrapped arrays and safely ignores invalid scores", () => {
  const scores = normalizeEmotionScores([[
    { label: "fear", score: Number.NaN },
    { label: "anger", score: -1 },
    { label: "surprise", score: "0.25" },
    { label: "surprise", score: 0.75 },
  ]]);

  assert.equal(scores.surprise, 1);
  assert.equal(scores.fear, 0);
  assert.equal(scores.anger, 0);
  assert.deepEqual(normalizeEmotionScores(null), Object.fromEntries(
    EMOTION_LABELS.map((label) => [label, 0]),
  ));
  assert.equal(normalizeEmotionScores({ JOY: 3, sadness: 1 }).joy, 0.75);
});

test("finds the dominant emotion without inventing one for empty scores", () => {
  assert.deepEqual(getDominantEmotion({ joy: 0.6, surprise: 0.4 }), {
    label: "joy",
    score: 0.6,
  });
  assert.equal(getDominantEmotion({}), null);
});

test("builds finite, fixed-order radar geometry and grid rings", () => {
  const geometry = buildRadarGeometry(
    { anger: 1, disgust: 1, fear: 1, joy: 1, neutral: 1, sadness: 1, surprise: 1 },
    { width: 200, height: 200, radius: 80, levels: 4 },
  );

  assert.equal(geometry.viewBox, "0 0 200 200");
  assert.equal(geometry.axes.length, 7);
  assert.equal(geometry.points.length, 7);
  assert.equal(geometry.rings.length, 4);
  assert.deepEqual(geometry.points.map(({ label }) => label), EMOTION_LABELS);
  assert(Math.abs(geometry.axes[0].x - 100) < 1e-10);
  assert(Math.abs(geometry.axes[0].y - 20) < 1e-10);
  assert(geometry.points.every(({ x, y }) => Number.isFinite(x) && Number.isFinite(y)));
  assert.equal(geometry.polygon.split(" ").length, 7);
  assert.equal(geometry.rings.at(-1).points.split(" ").length, 7);
});

test("formats only valid SVG radar points at a bounded precision", () => {
  assert.equal(
    formatRadarPoints([{ x: 1 / 3, y: -0 }, { x: 5, y: 6 }, { x: Number.NaN, y: 2 }], 2),
    "0.33,0.00 5.00,6.00",
  );
  assert.equal(formatRadarPoints(null), "");
});

test("classifyEmotions uses request IDs, forwards progress, and normalizes results", async () => {
  class FakeWorker extends EventTarget {
    messages = [];
    terminated = false;

    postMessage(message) {
      this.messages.push(message);
      if (message.type !== "classify") return;
      queueMicrotask(() => {
        this.dispatchEvent(new MessageEvent("message", {
          data: { type: "progress", requestId: message.requestId, progress: 42, loaded: 42, total: 100 },
        }));
        this.dispatchEvent(new MessageEvent("message", {
          data: {
            type: "result",
            requestId: message.requestId,
            scores: [{ label: "joy", score: 3 }, { label: "surprise", score: 1 }],
          },
        }));
      });
    }

    terminate() {
      this.terminated = true;
    }
  }

  const worker = new FakeWorker();
  const progress = [];
  const scores = await classifyEmotions("A wonderful surprise!", {
    workerFactory: () => worker,
    onProgress: (update) => progress.push(update),
  });

  assert.match(worker.messages[0].requestId, /^emotion-\d+$/);
  assert.equal(worker.messages[0].text, "A wonderful surprise!");
  assert.deepEqual(progress, [{ progress: 42, loaded: 42, total: 100 }]);
  assert.equal(scores.joy, 0.75);
  assert.equal(scores.surprise, 0.25);

  disposeEmotionModel();
  assert.equal(worker.terminated, true);
});

test("classifyEmotions rejects blank and aborted requests before creating a worker", async () => {
  let factoryCalls = 0;
  const workerFactory = () => {
    factoryCalls += 1;
    throw new Error("should not run");
  };

  await assert.rejects(classifyEmotions("   ", { workerFactory }), /provide a sentence/i);

  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    classifyEmotions("hello", { workerFactory, signal: controller.signal }),
    { name: "AbortError" },
  );
  assert.equal(factoryCalls, 0);
});

test("a worker-reported load failure can be followed by a successful retry", async () => {
  class RetryWorker extends EventTarget {
    attempts = 0;
    requestIds = [];

    postMessage(message) {
      if (message.type !== "classify") return;
      this.attempts += 1;
      this.requestIds.push(message.requestId);
      queueMicrotask(() => {
        if (this.attempts === 1) {
          this.dispatchEvent(new MessageEvent("message", {
            data: {
              type: "error",
              requestId: message.requestId,
              error: { name: "NetworkError", message: "Model download failed." },
            },
          }));
        } else {
          this.dispatchEvent(new MessageEvent("message", {
            data: {
              type: "result",
              requestId: message.requestId,
              scores: [{ label: "neutral", score: 1 }],
            },
          }));
        }
      });
    }

    terminate() {}
  }

  const worker = new RetryWorker();
  const workerFactory = () => worker;
  await assert.rejects(
    classifyEmotions("First try", { workerFactory }),
    { name: "NetworkError", message: "Model download failed." },
  );

  const scores = await classifyEmotions("Second try", { workerFactory });
  assert.equal(scores.neutral, 1);
  assert.equal(worker.attempts, 2);
  assert.equal(new Set(worker.requestIds).size, 2);
});
