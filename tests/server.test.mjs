import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createVibeCheckServer } from "../server.mjs";

function listen(server) {
  return new Promise((resolve, reject) => {
    const onError = (error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve();
    };

    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(0, "127.0.0.1");
  });
}

function close(server) {
  if (!server.listening) return Promise.resolve();

  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

async function createFixture(t) {
  const directory = mkdtempSync(join(tmpdir(), "vibecheck-server-"));
  const rootDirectory = join(directory, "public");
  const databasePath = join(rootDirectory, "data", "vibecheck.sqlite");

  mkdirSync(rootDirectory, { recursive: true });
  writeFileSync(
    join(rootDirectory, "index.html"),
    "<!doctype html><html><body><main>VibeCheck fixture page</main></body></html>",
  );
  writeFileSync(join(rootDirectory, "emotion-model.js"), "export const EMOTION_LABELS = [];\n");
  writeFileSync(join(rootDirectory, "emotion-worker.js"), "self.onmessage = () => {};\n");
  writeFileSync(join(rootDirectory, "server.mjs"), "SERVER_FILE_MUST_NOT_BE_PUBLIC");
  writeFileSync(join(rootDirectory, "package.json"), "PACKAGE_FILE_MUST_NOT_BE_PUBLIC");
  writeFileSync(join(directory, "outside-secret.txt"), "PATH_TRAVERSAL_MUST_NOT_WORK");

  let server;
  let store;

  try {
    ({ server, store } = createVibeCheckServer({ databasePath, rootDirectory }));
    await listen(server);
  } catch (error) {
    store?.close();
    rmSync(directory, { recursive: true, force: true });
    throw error;
  }

  t.after(async () => {
    try {
      await close(server);
    } finally {
      try {
        store.close();
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    }
  });

  const address = server.address();
  assert(address && typeof address === "object");

  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    store,
  };
}

function postJson(baseUrl, value) {
  return fetch(`${baseUrl}/api/sentences`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(value),
  });
}

test("POST /api/sentences stores trimmed input and returns its identity", async (t) => {
  const { baseUrl, store } = await createFixture(t);
  const response = await postJson(baseUrl, {
    sentence: "  I loved the movie, but the ending was disappointing. \n",
    challengeId: "mixed",
  });

  assert.equal(response.status, 201);
  assert.match(response.headers.get("content-type") ?? "", /^application\/json\b/i);

  const result = await response.json();
  assert(Number.isSafeInteger(result.id) && result.id > 0);
  assert.match(result.createdAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  assert.deepEqual(store.getById(result.id), {
    id: result.id,
    sentence: "I loved the movie, but the ending was disappointing.",
    challengeId: "mixed",
    createdAt: result.createdAt,
  });
  assert.equal(store.count(), 1);
});

test("SQL-looking and Unicode sentence text is persisted literally", async (t) => {
  const { baseUrl, store } = await createFixture(t);
  const sentence = "Nice'); DROP TABLE sentence_submissions; -- café 漢字 🌈😊";
  const response = await postJson(baseUrl, {
    sentence: `  ${sentence}  `,
    challengeId: "clear-vibe",
  });

  assert.equal(response.status, 201);
  const result = await response.json();
  assert.equal(store.getById(result.id).sentence, sentence);
  assert.equal(store.getById(result.id).challengeId, "clear-vibe");
  assert.equal(store.count(), 1);
});

test("invalid JSON submissions return 400 without inserting rows", async (t) => {
  const { baseUrl, store } = await createFixture(t);
  const cases = [
    {
      name: "empty sentence",
      body: JSON.stringify({ sentence: " \n\t ", challengeId: "sarcasm" }),
    },
    {
      name: "non-string sentence",
      body: JSON.stringify({ sentence: 42, challengeId: "mixed" }),
    },
    {
      name: "oversized sentence",
      body: JSON.stringify({ sentence: "🙂".repeat(241), challengeId: "clear-vibe" }),
    },
    {
      name: "unknown challenge",
      body: JSON.stringify({ sentence: "A valid sentence", challengeId: "unknown" }),
    },
    {
      name: "malformed JSON",
      body: '{"sentence":',
    },
  ];

  for (const { name, body } of cases) {
    const response = await fetch(`${baseUrl}/api/sentences`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    });

    assert.equal(response.status, 400, name);
    await response.text();
    assert.equal(store.count(), 0, `${name} must not insert a row`);
  }
});

test("POST /api/sentences rejects the wrong media type", async (t) => {
  const { baseUrl, store } = await createFixture(t);
  const response = await fetch(`${baseUrl}/api/sentences`, {
    method: "POST",
    headers: { "Content-Type": "text/plain" },
    body: JSON.stringify({ sentence: "This should not save.", challengeId: "mixed" }),
  });

  assert.equal(response.status, 415);
  await response.text();
  assert.equal(store.count(), 0);
});

test("POST /api/sentences rejects request bodies larger than 4096 bytes", async (t) => {
  const { baseUrl, store } = await createFixture(t);
  const body = JSON.stringify({
    sentence: "x".repeat(5_000),
    challengeId: "mixed",
  });
  assert(Buffer.byteLength(body) > 4_096);

  const response = await fetch(`${baseUrl}/api/sentences`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
  });

  assert.equal(response.status, 413);
  await response.text();
  assert.equal(store.count(), 0);
});

test("GET /api/sentences is method-restricted", async (t) => {
  const { baseUrl, store } = await createFixture(t);
  const response = await fetch(`${baseUrl}/api/sentences`);

  assert.equal(response.status, 405);
  assert.equal(response.headers.get("allow"), "POST");
  await response.text();
  assert.equal(store.count(), 0);
});

test("the static root serves index.html", async (t) => {
  const { baseUrl } = await createFixture(t);
  const response = await fetch(`${baseUrl}/`);

  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);
  assert.match(await response.text(), /VibeCheck fixture page/);
});

test("the browser emotion modules are served as JavaScript", async (t) => {
  const { baseUrl } = await createFixture(t);

  for (const path of ["/emotion-model.js", "/emotion-worker.js"]) {
    const response = await fetch(`${baseUrl}${path}`);
    assert.equal(response.status, 200, path);
    assert.match(response.headers.get("content-type") ?? "", /^text\/javascript\b/i, path);
    assert((await response.text()).length > 0, path);
  }
});

test("private and out-of-root files cannot be served", async (t) => {
  const { baseUrl } = await createFixture(t);
  const privatePaths = [
    "/data/vibecheck.sqlite",
    "/server.mjs",
    "/package.json",
    "/%2e%2e%2foutside-secret.txt",
  ];

  for (const path of privatePaths) {
    const response = await fetch(`${baseUrl}${path}`);
    assert.equal(response.status, 404, path);
    await response.text();
  }
});
