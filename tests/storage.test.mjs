import test from "node:test";
import assert from "node:assert/strict";
import { newDb } from "pg-mem";
import {
  createSentenceStore,
  databaseUrlFromEnvironment,
} from "../storage.mjs";

function createPool(database) {
  const adapter = database.adapters.createPg();
  return new adapter.Pool();
}

function createMemoryDatabase() {
  return newDb({ noAstCoverageCheck: true });
}

async function createTestStore(t, database = createMemoryDatabase()) {
  const store = await createSentenceStore({ pool: createPool(database) });
  t.after(() => store.close());
  return { database, store };
}

test("sentences persist when the store reconnects to the same database", async () => {
  const database = createMemoryDatabase();
  const firstStore = await createSentenceStore({ pool: createPool(database) });
  const saved = await firstStore.saveSentence({
    sentence: "Today has been calm, sunny, and lovely.",
    challengeId: "clear-vibe",
  });

  assert.equal(saved.id, 1);
  assert.equal(await firstStore.count(), 1);
  await firstStore.close();

  const reopenedStore = await createSentenceStore({ pool: createPool(database) });
  try {
    assert.equal(await reopenedStore.count(), 1);
    assert.deepEqual(await reopenedStore.getById(saved.id), saved);
  } finally {
    await reopenedStore.close();
  }
});

test("saveSentence trims input and records a UTC ISO timestamp", async (t) => {
  const { store } = await createTestStore(t);
  const before = Date.now();

  const saved = await store.saveSentence({
    sentence: "  I loved the movie, but the ending was disappointing.  ",
    challengeId: "mixed",
  });
  const after = Date.now();
  const timestamp = Date.parse(saved.createdAt);

  assert.equal(saved.sentence, "I loved the movie, but the ending was disappointing.");
  assert.equal(saved.challengeId, "mixed");
  assert.match(saved.createdAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  assert(timestamp >= before - 1_000 && timestamp <= after + 1_000);
});

test("validation rejects empty, oversized, and unknown-challenge submissions", async (t) => {
  const { store } = await createTestStore(t);

  await assert.rejects(
    store.saveSentence({ sentence: " \n\t ", challengeId: "sarcasm" }),
    /must not be empty/,
  );
  await assert.rejects(
    store.saveSentence({ sentence: "a".repeat(241), challengeId: "sarcasm" }),
    /240 characters or fewer/,
  );
  await assert.rejects(
    store.saveSentence({ sentence: "not\0safe", challengeId: "sarcasm" }),
    /null characters/,
  );
  await assert.rejects(
    store.saveSentence({ sentence: "A valid sentence", challengeId: "unknown" }),
    /challengeId/,
  );
  await assert.rejects(
    store.saveSentence({ sentence: 42, challengeId: "mixed" }),
    /sentence must be a string/,
  );
  assert.equal(await store.count(), 0);
});

test("all known challenge IDs are accepted", async (t) => {
  const { store } = await createTestStore(t);

  for (const challengeId of ["sarcasm", "clear-vibe", "mixed"]) {
    await store.saveSentence({ sentence: `Submission for ${challengeId}`, challengeId });
  }

  assert.equal(await store.count(), 3);
});

test("sentence values are bound as data instead of interpreted as SQL", async (t) => {
  const { store } = await createTestStore(t);
  const injectionText = "Nice'); DROP TABLE sentence_submissions; --";

  const saved = await store.saveSentence({ sentence: injectionText, challengeId: "clear-vibe" });
  const second = await store.saveSentence({ sentence: "The table still works.", challengeId: "mixed" });

  assert.equal((await store.getById(saved.id)).sentence, injectionText);
  assert.equal(second.id, 2);
  assert.equal(await store.count(), 2);
});

test("database URL configuration supports Render and Clever Cloud names", () => {
  assert.equal(
    databaseUrlFromEnvironment({ DATABASE_URL: "postgresql://render-value" }),
    "postgresql://render-value",
  );
  assert.equal(
    databaseUrlFromEnvironment({ POSTGRESQL_ADDON_URI: "postgresql://clever-value" }),
    "postgresql://clever-value",
  );
  assert.equal(
    databaseUrlFromEnvironment({
      DATABASE_URL: " ",
      POSTGRESQL_ADDON_URI: "postgresql://clever-fallback",
    }),
    "postgresql://clever-fallback",
  );
  assert.throws(() => databaseUrlFromEnvironment({}), /DATABASE_URL/);
});

test("store methods reject calls after the connection pool closes", async () => {
  const store = await createSentenceStore({ pool: createPool(createMemoryDatabase()) });
  await store.close();
  await store.close();

  await assert.rejects(store.count(), /closed/);
  await assert.rejects(
    store.saveSentence({ sentence: "Too late", challengeId: "mixed" }),
    /closed/,
  );
});
