import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { newDb } from "pg-mem";
import { createVibeCheckServer } from "../server.mjs";
import { createSentenceStore } from "../storage.mjs";

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
  let closeResources;

  try {
    const database = newDb({ noAstCoverageCheck: true });
    const adapter = database.adapters.createPg();
    store = await createSentenceStore({ pool: new adapter.Pool() });
    ({ server, closeResources } = createVibeCheckServer({ rootDirectory, store }));
    await listen(server);
  } catch (error) {
    await store?.close();
    rmSync(directory, { recursive: true, force: true });
    throw error;
  }

  t.after(async () => {
    try {
      await close(server);
    } finally {
      try {
        await closeResources();
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

function requestHeaders(cookie, contentType = "application/json") {
  return {
    ...(contentType ? { "Content-Type": contentType } : {}),
    ...(cookie ? { Cookie: cookie } : {}),
  };
}

function postJson(baseUrl, path, value, cookie) {
  return fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: requestHeaders(cookie),
    body: JSON.stringify(value),
  });
}

function sessionCookie(response) {
  const setCookie = response.headers.get("set-cookie");
  assert(setCookie, "response should set a session cookie");
  return setCookie.split(";", 1)[0];
}

async function registerParticipant(baseUrl, displayName) {
  const response = await postJson(baseUrl, "/api/participants", { displayName });
  assert.equal(response.status, 201);
  const body = await response.json();
  return {
    body,
    cookie: sessionCookie(response),
    setCookie: response.headers.get("set-cookie"),
  };
}

function postSentence(baseUrl, value, cookie) {
  return postJson(baseUrl, "/api/sentences", value, cookie);
}

test("a first visit has no participant session", async (t) => {
  const { baseUrl } = await createFixture(t);
  const response = await fetch(`${baseUrl}/api/session`);

  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^application\/json\b/i);
  assert.deepEqual(await response.json(), { participant: null });
});

test("POST /api/participants creates a participant and restorable HttpOnly cookie", async (t) => {
  const { baseUrl, store } = await createFixture(t);
  const registration = await registerParticipant(baseUrl, "  Jose\u0301   🌟  ");

  assert.equal(registration.body.participant.displayName, "José 🌟");
  assert.match(registration.setCookie, /^vibecheck_session=[A-Za-z0-9_-]+;/i);
  assert.match(registration.setCookie, /;\s*HttpOnly\b/i);
  assert.match(registration.setCookie, /;\s*SameSite=Lax\b/i);
  assert.match(registration.setCookie, /;\s*Path=\//i);
  assert.match(registration.setCookie, /;\s*Max-Age=2592000\b/i);
  assert.equal(await store.countParticipants(), 1);

  const restored = await fetch(`${baseUrl}/api/session`, {
    headers: { Cookie: registration.cookie },
  });
  assert.equal(restored.status, 200);
  assert.equal((await restored.json()).participant.displayName, "José 🌟");
});

test("participant cookies are marked Secure behind Render's HTTPS proxy", async (t) => {
  const { baseUrl } = await createFixture(t);
  const response = await fetch(`${baseUrl}/api/participants`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Forwarded-Proto": "https",
    },
    body: JSON.stringify({ displayName: "Secure learner" }),
  });

  assert.equal(response.status, 201);
  assert.match(response.headers.get("set-cookie") ?? "", /;\s*Secure\b/i);
  await response.text();
});

test("participant registration validates names without requiring them to be unique", async (t) => {
  const { baseUrl, store } = await createFixture(t);
  const invalidCases = [
    { displayName: "   " },
    { displayName: "🙂".repeat(41) },
    { displayName: "Sam\0Student" },
    { displayName: "Sam\nStudent" },
    { displayName: 42 },
  ];

  for (const value of invalidCases) {
    const response = await postJson(baseUrl, "/api/participants", value);
    assert.equal(response.status, 400, JSON.stringify(value));
    assert.equal(response.headers.get("set-cookie"), null);
    await response.text();
  }

  const malformed = await fetch(`${baseUrl}/api/participants`, {
    method: "POST",
    headers: requestHeaders(),
    body: '{"displayName":',
  });
  assert.equal(malformed.status, 400);
  await malformed.text();
  assert.equal(await store.countParticipants(), 0);

  const first = await registerParticipant(baseUrl, "Alex");
  const second = await registerParticipant(baseUrl, "Alex");
  assert.notEqual(first.cookie, second.cookie);
  assert.equal(await store.countParticipants(), 2);
});

test("POST /api/sentences requires a valid, unexpired participant cookie", async (t) => {
  const { baseUrl, store } = await createFixture(t);
  const sentence = { sentence: "This should not save.", challengeId: "mixed" };

  const missing = await postSentence(baseUrl, sentence);
  assert.equal(missing.status, 401);
  await missing.text();

  const tampered = await postSentence(baseUrl, sentence, "vibecheck_session=tampered-token");
  assert.equal(tampered.status, 401);
  await tampered.text();

  const expiredToken = "e".repeat(43);
  await store.createParticipant({
    displayName: "Expired learner",
    sessionTokenHash: createHash("sha256").update(expiredToken).digest("hex"),
    sessionExpiresAt: new Date(Date.now() - 60_000).toISOString(),
  });
  const expired = await postSentence(
    baseUrl,
    sentence,
    `vibecheck_session=${expiredToken}`,
  );
  assert.equal(expired.status, 401);
  await expired.text();

  assert.equal(await store.count(), 0);
});

test("POST /api/sentences stores the authenticated participant and ignores a forged ID", async (t) => {
  const { baseUrl, store } = await createFixture(t);
  const { cookie } = await registerParticipant(baseUrl, "Riley");
  const response = await postSentence(
    baseUrl,
    {
      sentence: "  I loved the movie, but the ending was disappointing. \n",
      challengeId: "mixed",
      participantId: 0,
    },
    cookie,
  );

  assert.equal(response.status, 201);
  assert.match(response.headers.get("content-type") ?? "", /^application\/json\b/i);

  const result = await response.json();
  assert(Number.isSafeInteger(result.id) && result.id > 0);
  assert.match(result.createdAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  const saved = await store.getById(result.id);
  assert.equal(saved.sentence, "I loved the movie, but the ending was disappointing.");
  assert.notEqual(saved.participantId, 0);
  assert.equal((await store.getParticipantById(saved.participantId)).displayName, "Riley");
  assert.equal(await store.count(), 1);
});

test("two learners with the same name remain linked to different submissions", async (t) => {
  const { baseUrl, store } = await createFixture(t);
  const first = await registerParticipant(baseUrl, "Alex");
  const second = await registerParticipant(baseUrl, "Alex");

  const firstResponse = await postSentence(
    baseUrl,
    { sentence: "First learner's message.", challengeId: "clear-vibe" },
    first.cookie,
  );
  const secondResponse = await postSentence(
    baseUrl,
    { sentence: "Second learner's message.", challengeId: "mixed" },
    second.cookie,
  );
  assert.equal(firstResponse.status, 201);
  assert.equal(secondResponse.status, 201);

  const firstSaved = await store.getById((await firstResponse.json()).id);
  const secondSaved = await store.getById((await secondResponse.json()).id);
  assert.notEqual(firstSaved.participantId, secondSaved.participantId);
  assert.equal((await store.getParticipantById(firstSaved.participantId)).displayName, "Alex");
  assert.equal((await store.getParticipantById(secondSaved.participantId)).displayName, "Alex");
});

test("SQL-looking and Unicode sentence text is persisted literally for its participant", async (t) => {
  const { baseUrl, store } = await createFixture(t);
  const { cookie } = await registerParticipant(baseUrl, "Taylor");
  const sentence = "Nice'); DROP TABLE sentence_submissions; -- café 漢字 🌈😊";
  const response = await postSentence(
    baseUrl,
    { sentence: `  ${sentence}  `, challengeId: "clear-vibe" },
    cookie,
  );

  assert.equal(response.status, 201);
  const result = await response.json();
  assert.equal((await store.getById(result.id)).sentence, sentence);
  assert.equal((await store.getById(result.id)).challengeId, "clear-vibe");
  assert.equal(await store.count(), 1);
});

test("invalid sentence JSON returns 400 without inserting rows", async (t) => {
  const { baseUrl, store } = await createFixture(t);
  const { cookie } = await registerParticipant(baseUrl, "Jordan");
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
      headers: requestHeaders(cookie),
      body,
    });

    assert.equal(response.status, 400, name);
    await response.text();
    assert.equal(await store.count(), 0, `${name} must not insert a row`);
  }
});

test("POST /api/sentences rejects the wrong media type for an authenticated participant", async (t) => {
  const { baseUrl, store } = await createFixture(t);
  const { cookie } = await registerParticipant(baseUrl, "Morgan");
  const response = await fetch(`${baseUrl}/api/sentences`, {
    method: "POST",
    headers: requestHeaders(cookie, "text/plain"),
    body: JSON.stringify({ sentence: "This should not save.", challengeId: "mixed" }),
  });

  assert.equal(response.status, 415);
  await response.text();
  assert.equal(await store.count(), 0);
});

test("POST /api/sentences rejects request bodies larger than 4096 bytes", async (t) => {
  const { baseUrl, store } = await createFixture(t);
  const { cookie } = await registerParticipant(baseUrl, "Quinn");
  const body = JSON.stringify({
    sentence: "x".repeat(5_000),
    challengeId: "mixed",
  });
  assert(Buffer.byteLength(body) > 4_096);

  const response = await fetch(`${baseUrl}/api/sentences`, {
    method: "POST",
    headers: requestHeaders(cookie),
    body,
  });

  assert.equal(response.status, 413);
  await response.text();
  assert.equal(await store.count(), 0);
});

test("GET /api/sentences is method-restricted", async (t) => {
  const { baseUrl, store } = await createFixture(t);
  const response = await fetch(`${baseUrl}/api/sentences`);

  assert.equal(response.status, 405);
  assert.equal(response.headers.get("allow"), "POST");
  await response.text();
  assert.equal(await store.count(), 0);
});

test("DELETE /api/session clears the browser identity without deleting its history", async (t) => {
  const { baseUrl, store } = await createFixture(t);
  const first = await registerParticipant(baseUrl, "First learner");
  const savedResponse = await postSentence(
    baseUrl,
    { sentence: "Keep this historical message.", challengeId: "clear-vibe" },
    first.cookie,
  );
  assert.equal(savedResponse.status, 201);
  const savedId = (await savedResponse.json()).id;

  const logout = await fetch(`${baseUrl}/api/session`, {
    method: "DELETE",
    headers: { Cookie: first.cookie },
  });
  assert.equal(logout.status, 204);
  assert.match(logout.headers.get("set-cookie") ?? "", /^vibecheck_session=;/i);
  assert.match(logout.headers.get("set-cookie") ?? "", /Max-Age=0/i);

  const replay = await postSentence(
    baseUrl,
    { sentence: "A cleared cookie must not remain usable.", challengeId: "mixed" },
    first.cookie,
  );
  assert.equal(replay.status, 401);
  await replay.text();
  assert.equal(await store.count(), 1);

  const replayedSession = await fetch(`${baseUrl}/api/session`, {
    headers: { Cookie: first.cookie },
  });
  assert.equal(replayedSession.status, 200);
  assert.deepEqual(await replayedSession.json(), { participant: null });

  const noSession = await fetch(`${baseUrl}/api/session`);
  assert.deepEqual(await noSession.json(), { participant: null });
  const second = await registerParticipant(baseUrl, "Second learner");
  assert.notEqual(first.cookie, second.cookie);
  assert.equal(await store.countParticipants(), 2);
  assert.equal((await store.getById(savedId)).sentence, "Keep this historical message.");
});

test("invalid session cookies are treated as signed-out and cleared", async (t) => {
  const { baseUrl } = await createFixture(t);
  const response = await fetch(`${baseUrl}/api/session`, {
    headers: { Cookie: "vibecheck_session=not-a-real-session" },
  });

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { participant: null });
  assert.match(response.headers.get("set-cookie") ?? "", /^vibecheck_session=;/i);
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
    "/storage.mjs",
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
