import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSentenceStore } from "../storage.mjs";

function createTemporaryDatabase(t) {
  const directory = mkdtempSync(join(tmpdir(), "vibecheck-store-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return join(directory, "nested", "vibecheck.sqlite");
}

test("sentences persist after the database is closed and reopened", (t) => {
  const databasePath = createTemporaryDatabase(t);
  const firstStore = createSentenceStore(databasePath);
  const saved = firstStore.saveSentence({
    sentence: "Today has been calm, sunny, and lovely.",
    challengeId: "clear-vibe",
  });

  assert.equal(saved.id, 1);
  assert.equal(firstStore.count(), 1);
  firstStore.close();

  const reopenedStore = createSentenceStore(databasePath);
  t.after(() => reopenedStore.close());

  assert.equal(reopenedStore.count(), 1);
  assert.deepEqual(reopenedStore.getById(saved.id), saved);
});

test("saveSentence trims input and records a UTC ISO timestamp", (t) => {
  const store = createSentenceStore(":memory:");
  t.after(() => store.close());
  const before = Date.now();

  const saved = store.saveSentence({
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

test("validation rejects empty, oversized, and unknown-challenge submissions", (t) => {
  const store = createSentenceStore(":memory:");
  t.after(() => store.close());

  assert.throws(
    () => store.saveSentence({ sentence: " \n\t ", challengeId: "sarcasm" }),
    /must not be empty/,
  );
  assert.throws(
    () => store.saveSentence({ sentence: "a".repeat(241), challengeId: "sarcasm" }),
    /240 characters or fewer/,
  );
  assert.throws(
    () => store.saveSentence({ sentence: "not\0safe", challengeId: "sarcasm" }),
    /null characters/,
  );
  assert.throws(
    () => store.saveSentence({ sentence: "A valid sentence", challengeId: "unknown" }),
    /challengeId/,
  );
  assert.throws(
    () => store.saveSentence({ sentence: 42, challengeId: "mixed" }),
    /sentence must be a string/,
  );
  assert.equal(store.count(), 0);
});

test("all known challenge IDs are accepted", (t) => {
  const store = createSentenceStore(":memory:");
  t.after(() => store.close());

  for (const challengeId of ["sarcasm", "clear-vibe", "mixed"]) {
    store.saveSentence({ sentence: `Submission for ${challengeId}`, challengeId });
  }

  assert.equal(store.count(), 3);
});

test("sentence values are bound as data instead of interpreted as SQL", (t) => {
  const store = createSentenceStore(":memory:");
  t.after(() => store.close());
  const injectionText = "Nice'); DROP TABLE sentence_submissions; --";

  const saved = store.saveSentence({ sentence: injectionText, challengeId: "clear-vibe" });
  const second = store.saveSentence({ sentence: "The table still works.", challengeId: "mixed" });

  assert.equal(store.getById(saved.id).sentence, injectionText);
  assert.equal(second.id, 2);
  assert.equal(store.count(), 2);
});
