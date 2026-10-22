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

let participantSequence = 0;

function participantInput(overrides = {}) {
  participantSequence += 1;
  return {
    displayName: `Learner ${participantSequence}`,
    sessionTokenHash: participantSequence.toString(16).padStart(64, "0"),
    sessionExpiresAt: new Date(Date.now() + 24 * 60 * 60 * 1_000).toISOString(),
    ...overrides,
  };
}

async function addParticipant(store, overrides = {}) {
  return store.createParticipant(participantInput(overrides));
}

function waitForClockTick() {
  return new Promise((resolve) => setTimeout(resolve, 10));
}

test("participants and their sentences persist when the store reconnects", async () => {
  const database = createMemoryDatabase();
  const firstStore = await createSentenceStore({ pool: createPool(database) });
  const participant = await addParticipant(firstStore, { displayName: "Ari" });
  const saved = await firstStore.saveSentence({
    sentence: "Today has been calm, sunny, and lovely.",
    challengeId: "clear-vibe",
    participantId: participant.id,
  });

  assert.equal(saved.id, 1);
  assert.equal(saved.participantId, participant.id);
  assert.equal(await firstStore.count(), 1);
  assert.equal(await firstStore.countParticipants(), 1);
  await firstStore.close();

  const reopenedStore = await createSentenceStore({ pool: createPool(database) });
  try {
    assert.equal(await reopenedStore.count(), 1);
    assert.equal(await reopenedStore.countParticipants(), 1);
    assert.deepEqual(await reopenedStore.getById(saved.id), saved);
    assert.deepEqual(await reopenedStore.getParticipantById(participant.id), participant);
  } finally {
    await reopenedStore.close();
  }
});

test("participant names are normalized and session hashes restore active participants", async (t) => {
  const { store } = await createTestStore(t);
  const input = participantInput({
    displayName: "  Jose\u0301   🌟  ",
    sessionTokenHash: "a".repeat(64),
  });
  const participant = await store.createParticipant(input);

  assert.equal(participant.displayName, "José 🌟");
  assert.equal(participant.isLegacy, false);
  assert(Number.isSafeInteger(participant.id) && participant.id > 0);
  assert.match(participant.createdAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  assert.deepEqual(await store.getParticipantBySessionHash(input.sessionTokenHash), participant);
  assert.deepEqual(await store.getParticipantById(participant.id), participant);
  assert.equal(await store.countParticipants(), 1);
});

test("duplicate display names create distinct participants", async (t) => {
  const { store } = await createTestStore(t);
  const first = await addParticipant(store, { displayName: "Alex" });
  const second = await addParticipant(store, { displayName: "Alex" });

  assert.notEqual(first.id, second.id);
  assert.equal(first.displayName, "Alex");
  assert.equal(second.displayName, "Alex");
  assert.equal(await store.countParticipants(), 2);
});

test("participant validation rejects unsafe or malformed values", async (t) => {
  const { store } = await createTestStore(t);
  const cases = [
    { displayName: "   ", expected: /must not be empty/i },
    { displayName: "🙂".repeat(41), expected: /40 characters or fewer/i },
    { displayName: "Sam\0Student", expected: /control|null/i },
    { displayName: "Sam\nStudent", expected: /control/i },
    { displayName: 42, expected: /displayName must be a string/i },
    { displayName: "Valid", sessionTokenHash: "short", expected: /sessionTokenHash/i },
    { displayName: "Valid", sessionExpiresAt: "not-a-date", expected: /sessionExpiresAt/i },
  ];

  for (const { expected, ...overrides } of cases) {
    await assert.rejects(
      store.createParticipant(participantInput(overrides)),
      expected,
      JSON.stringify(overrides),
    );
  }

  assert.equal(await store.countParticipants(), 0);
});

test("participant names and hashes are bound as data", async (t) => {
  const { store } = await createTestStore(t);
  const displayName = "Alex'); DROP TABLE participants; --";
  const participant = await addParticipant(store, { displayName });
  const second = await addParticipant(store, { displayName: "The table still works" });

  assert.equal((await store.getParticipantById(participant.id)).displayName, displayName);
  assert.equal(second.id, participant.id + 1);
  assert.equal(await store.countParticipants(), 2);
});

test("expired participant sessions are not restored", async (t) => {
  const { store } = await createTestStore(t);
  const input = participantInput({
    displayName: "Past learner",
    sessionExpiresAt: new Date(Date.now() - 60_000).toISOString(),
  });
  const participant = await store.createParticipant(input);

  assert.deepEqual(await store.getParticipantById(participant.id), participant);
  assert.equal(await store.getParticipantBySessionHash(input.sessionTokenHash), null);
  assert.equal(await store.getParticipantBySessionHash("f".repeat(64)), null);
  assert.equal(await store.countParticipants(), 1);
});

test("revoking a participant session prevents its token hash from being restored", async (t) => {
  const { store } = await createTestStore(t);
  const input = participantInput({ displayName: "Switching learner" });
  const participant = await store.createParticipant(input);

  assert.deepEqual(await store.getParticipantBySessionHash(input.sessionTokenHash), participant);
  assert.equal(await store.revokeParticipantSession(input.sessionTokenHash), true);
  assert.equal(await store.getParticipantBySessionHash(input.sessionTokenHash), null);
  assert.deepEqual(await store.getParticipantById(participant.id), participant);
  assert.equal(await store.countParticipants(), 1);

  assert.equal(await store.revokeParticipantSession("f".repeat(64)), false);
  await assert.rejects(
    store.revokeParticipantSession("not-a-hash"),
    /sessionTokenHash/i,
  );
});

test("saveSentence records its participant, trims input, and records a UTC timestamp", async (t) => {
  const { store } = await createTestStore(t);
  const participant = await addParticipant(store);
  const before = Date.now();

  const saved = await store.saveSentence({
    sentence: "  I loved the movie, but the ending was disappointing.  ",
    challengeId: "mixed",
    participantId: participant.id,
  });
  const after = Date.now();
  const timestamp = Date.parse(saved.createdAt);

  assert.equal(saved.sentence, "I loved the movie, but the ending was disappointing.");
  assert.equal(saved.challengeId, "mixed");
  assert.equal(saved.participantId, participant.id);
  assert.match(saved.createdAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  assert(timestamp >= before - 1_000 && timestamp <= after + 1_000);
});

test("saveScaleResult stores and replaces an ordered vibe-scale snapshot", async (t) => {
  const { store } = await createTestStore(t);
  const participant = await addParticipant(store);
  const submission = await store.saveSentence({
    sentence: "Wow 😊!",
    challengeId: "clear-vibe",
    participantId: participant.id,
  });
  const firstPlacements = [
    { tokenIndex: 0, tokenText: "Wow", rating: 1 },
    { tokenIndex: 1, tokenText: "😊", rating: 1 },
    { tokenIndex: 2, tokenText: "!", rating: 0 },
  ];

  const firstResult = await store.saveScaleResult({
    submissionId: submission.id,
    participantId: participant.id,
    placements: firstPlacements,
    challengePassed: true,
  });

  assert.equal(firstResult.initialChallengePassed, true);
  assert.equal(firstResult.challengePassed, true);
  assert.match(firstResult.challengeCompletedAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.match(firstResult.scaleSubmittedAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.deepEqual(firstResult.wordPlacements, firstPlacements);
  assert.deepEqual(await store.getById(submission.id), firstResult);

  const replacementPlacements = firstPlacements.map((placement) => ({
    ...placement,
    rating: placement.tokenIndex === 0 ? -1 : 0,
  }));
  await waitForClockTick();
  const replacement = await store.saveScaleResult({
    submissionId: submission.id,
    participantId: participant.id,
    placements: replacementPlacements,
    challengePassed: false,
  });

  assert.equal(replacement.initialChallengePassed, true);
  assert.equal(replacement.challengePassed, true);
  assert.equal(replacement.challengeCompletedAt, firstResult.challengeCompletedAt);
  assert.equal(replacement.scaleSubmittedAt, firstResult.scaleSubmittedAt);
  assert.deepEqual(replacement.wordPlacements, replacementPlacements);
  assert.deepEqual(await store.getById(submission.id), replacement);
});

test("saveScaleResult validates placements and enforces submission ownership", async (t) => {
  const { store } = await createTestStore(t);
  const owner = await addParticipant(store);
  const otherLearner = await addParticipant(store);
  const submission = await store.saveSentence({
    sentence: "A valid sentence.",
    challengeId: "mixed",
    participantId: owner.id,
  });
  const valid = {
    submissionId: submission.id,
    participantId: owner.id,
    challengePassed: true,
    placements: [{ tokenIndex: 0, tokenText: "A", rating: 0 }],
  };

  await assert.rejects(
    store.saveScaleResult({ ...valid, placements: [] }),
    /non-empty array/i,
  );
  await assert.rejects(
    store.saveScaleResult({
      ...valid,
      placements: [{ tokenIndex: 1, tokenText: "A", rating: 0 }],
    }),
    /contiguous/i,
  );
  await assert.rejects(
    store.saveScaleResult({
      ...valid,
      placements: [{ tokenIndex: 0, tokenText: "A", rating: 0.5 }],
    }),
    /rating/i,
  );
  await assert.rejects(
    store.saveScaleResult({ ...valid, challengePassed: "yes" }),
    /challengePassed/i,
  );
  assert.equal(
    await store.saveScaleResult({ ...valid, participantId: otherLearner.id }),
    null,
  );

  const unchanged = await store.getById(submission.id);
  assert.equal(unchanged.initialChallengePassed, null);
  assert.equal(unchanged.challengePassed, null);
  assert.equal(unchanged.challengeCompletedAt, null);
  assert.equal(unchanged.scaleSubmittedAt, null);
  assert.deepEqual(unchanged.wordPlacements, []);
});

test("completeChallenge records a later pass without changing the initial result", async (t) => {
  const { store } = await createTestStore(t);
  const participant = await addParticipant(store);
  const submission = await store.saveSentence({
    sentence: "The concert was fine.",
    challengeId: "clear-vibe",
    participantId: participant.id,
  });
  const revealed = await store.saveScaleResult({
    submissionId: submission.id,
    participantId: participant.id,
    placements: [
      { tokenIndex: 0, tokenText: "The", rating: 0 },
      { tokenIndex: 1, tokenText: "concert", rating: 0 },
      { tokenIndex: 2, tokenText: "was", rating: 0 },
      { tokenIndex: 3, tokenText: "fine", rating: 1 },
      { tokenIndex: 4, tokenText: ".", rating: 0 },
    ],
    challengePassed: false,
  });

  assert.equal(revealed.initialChallengePassed, false);
  assert.equal(revealed.challengePassed, false);
  assert.equal(revealed.challengeCompletedAt, null);

  const completed = await store.completeChallenge({
    submissionId: submission.id,
    participantId: participant.id,
  });

  assert.equal(completed.initialChallengePassed, false);
  assert.equal(completed.challengePassed, true);
  assert.match(completed.challengeCompletedAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(completed.sentence, submission.sentence);

  await waitForClockTick();
  const repeated = await store.completeChallenge({
    submissionId: submission.id,
    participantId: participant.id,
  });
  assert.equal(repeated.initialChallengePassed, false);
  assert.equal(repeated.challengePassed, true);
  assert.equal(repeated.challengeCompletedAt, completed.challengeCompletedAt);
  const stored = await store.getById(submission.id);
  assert.equal(stored.initialChallengePassed, false);
  assert.equal(stored.challengePassed, true);
  assert.equal(stored.challengeCompletedAt, completed.challengeCompletedAt);
});

test("completeChallenge enforces submission ownership", async (t) => {
  const { store } = await createTestStore(t);
  const owner = await addParticipant(store);
  const otherLearner = await addParticipant(store);
  const submission = await store.saveSentence({
    sentence: "The concert happened.",
    challengeId: "clear-vibe",
    participantId: owner.id,
  });
  await store.saveScaleResult({
    submissionId: submission.id,
    participantId: owner.id,
    placements: [{ tokenIndex: 0, tokenText: "The", rating: 0 }],
    challengePassed: false,
  });

  assert.equal(
    await store.completeChallenge({
      submissionId: submission.id,
      participantId: otherLearner.id,
    }),
    null,
  );
  assert.equal(
    await store.completeChallenge({
      submissionId: 999_999,
      participantId: owner.id,
    }),
    null,
  );

  const unchanged = await store.getById(submission.id);
  assert.equal(unchanged.initialChallengePassed, false);
  assert.equal(unchanged.challengePassed, false);
  assert.equal(unchanged.challengeCompletedAt, null);
});

test("sentence validation rejects malformed submissions and missing participants", async (t) => {
  const { store } = await createTestStore(t);
  const participant = await addParticipant(store);
  const validIdentity = { challengeId: "sarcasm", participantId: participant.id };

  await assert.rejects(
    store.saveSentence({ sentence: " \n\t ", ...validIdentity }),
    /must not be empty/,
  );
  await assert.rejects(
    store.saveSentence({ sentence: "a".repeat(241), ...validIdentity }),
    /240 characters or fewer/,
  );
  await assert.rejects(
    store.saveSentence({ sentence: "not\0safe", ...validIdentity }),
    /null characters/,
  );
  await assert.rejects(
    store.saveSentence({
      sentence: "A valid sentence",
      challengeId: "unknown",
      participantId: participant.id,
    }),
    /challengeId/,
  );
  await assert.rejects(
    store.saveSentence({ sentence: 42, challengeId: "mixed", participantId: participant.id }),
    /sentence must be a string/,
  );
  await assert.rejects(
    store.saveSentence({ sentence: "No learner", challengeId: "mixed" }),
    /participantId/,
  );
  assert.equal(await store.count(), 0);
});

test("the participant foreign key rejects unknown participant IDs", async (t) => {
  const { store } = await createTestStore(t);

  await assert.rejects(
    store.saveSentence({
      sentence: "This learner does not exist.",
      challengeId: "mixed",
      participantId: 999_999,
    }),
    /foreign key|participant/i,
  );
  assert.equal(await store.count(), 0);
});

test("all known challenge IDs are accepted for an identified participant", async (t) => {
  const { store } = await createTestStore(t);
  const participant = await addParticipant(store);

  for (const challengeId of ["sarcasm", "clear-vibe", "mixed"]) {
    await store.saveSentence({
      sentence: `Submission for ${challengeId}`,
      challengeId,
      participantId: participant.id,
    });
  }

  assert.equal(await store.count(), 3);
});

test("sentence values are bound as data instead of interpreted as SQL", async (t) => {
  const { store } = await createTestStore(t);
  const participant = await addParticipant(store);
  const injectionText = "Nice'); DROP TABLE sentence_submissions; --";

  const saved = await store.saveSentence({
    sentence: injectionText,
    challengeId: "clear-vibe",
    participantId: participant.id,
  });
  const second = await store.saveSentence({
    sentence: "The table still works.",
    challengeId: "mixed",
    participantId: participant.id,
  });

  assert.equal((await store.getById(saved.id)).sentence, injectionText);
  assert.equal(second.id, 2);
  assert.equal(await store.count(), 2);
});

test("startup migrates existing submissions to the legacy participant", async () => {
  const database = createMemoryDatabase();
  const setupPool = createPool(database);
  await setupPool.query(`
    CREATE TABLE sentence_submissions (
      id SERIAL PRIMARY KEY,
      sentence VARCHAR(240) NOT NULL CHECK (sentence <> ''),
      challenge_id TEXT NOT NULL CHECK (challenge_id IN ('sarcasm', 'clear-vibe', 'mixed')),
      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    INSERT INTO sentence_submissions (sentence, challenge_id)
    VALUES ('Saved before participant names existed.', 'mixed');
  `);
  await setupPool.end();

  const store = await createSentenceStore({ pool: createPool(database) });
  try {
    const migrated = await store.getById(1);
    const legacyParticipant = await store.getParticipantById(0);

    assert.equal(migrated.sentence, "Saved before participant names existed.");
    assert.equal(migrated.participantId, 0);
    assert.equal(migrated.initialChallengePassed, null);
    assert.equal(migrated.challengePassed, null);
    assert.equal(migrated.challengeCompletedAt, null);
    assert.equal(migrated.scaleSubmittedAt, null);
    assert.deepEqual(migrated.wordPlacements, []);
    assert.equal(legacyParticipant.id, 0);
    assert.equal(legacyParticipant.isLegacy, true);
    assert.match(legacyParticipant.displayName, /before names|legacy/i);
    assert.equal(await store.countParticipants(), 0);

    const participant = await addParticipant(store, { displayName: "New learner" });
    assert(participant.id > 0);
    assert.equal(await store.countParticipants(), 1);
  } finally {
    await store.close();
  }
});

test("startup backfills initial and completion fields from the previous result schema", async () => {
  const database = createMemoryDatabase();
  const setupPool = createPool(database);
  await setupPool.query(`
    CREATE TABLE sentence_submissions (
      id SERIAL PRIMARY KEY,
      participant_id BIGINT NOT NULL,
      sentence VARCHAR(240) NOT NULL CHECK (sentence <> ''),
      challenge_id TEXT NOT NULL CHECK (challenge_id IN ('sarcasm', 'clear-vibe', 'mixed')),
      challenge_passed BOOLEAN,
      scale_submitted_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    INSERT INTO sentence_submissions (
      participant_id,
      sentence,
      challenge_id,
      challenge_passed,
      scale_submitted_at
    ) VALUES
      (0, 'Previously passed.', 'clear-vibe', TRUE, '2026-01-02T03:04:05.000Z'),
      (0, 'Previously failed.', 'clear-vibe', FALSE, '2026-02-03T04:05:06.000Z'),
      (0, 'Not evaluated yet.', 'mixed', NULL, '2026-03-04T05:06:07.000Z');
  `);
  await setupPool.end();

  const store = await createSentenceStore({ pool: createPool(database) });
  try {
    const passed = await store.getById(1);
    assert.equal(passed.initialChallengePassed, true);
    assert.equal(passed.challengePassed, true);
    assert.equal(passed.scaleSubmittedAt, "2026-01-02T03:04:05.000Z");
    assert.equal(passed.challengeCompletedAt, passed.scaleSubmittedAt);

    const failed = await store.getById(2);
    assert.equal(failed.initialChallengePassed, false);
    assert.equal(failed.challengePassed, false);
    assert.equal(failed.scaleSubmittedAt, "2026-02-03T04:05:06.000Z");
    assert.equal(failed.challengeCompletedAt, null);

    const unevaluated = await store.getById(3);
    assert.equal(unevaluated.initialChallengePassed, null);
    assert.equal(unevaluated.challengePassed, null);
    assert.equal(unevaluated.scaleSubmittedAt, "2026-03-04T05:06:07.000Z");
    assert.equal(unevaluated.challengeCompletedAt, null);
  } finally {
    await store.close();
  }
});

test("startup adds the participant foreign key when an existing column lacks it", async () => {
  const database = createMemoryDatabase();
  const setupPool = createPool(database);
  await setupPool.query(`
    CREATE TABLE sentence_submissions (
      id SERIAL PRIMARY KEY,
      participant_id BIGINT NOT NULL,
      sentence VARCHAR(240) NOT NULL CHECK (sentence <> ''),
      challenge_id TEXT NOT NULL CHECK (challenge_id IN ('sarcasm', 'clear-vibe', 'mixed')),
      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    INSERT INTO sentence_submissions (participant_id, sentence, challenge_id)
    VALUES (0, 'Saved while the participant foreign key was missing.', 'mixed');
  `);
  await setupPool.end();

  const store = await createSentenceStore({ pool: createPool(database) });
  try {
    const migrated = await store.getById(1);
    assert.equal(migrated.participantId, 0);
    assert.equal(
      (await store.getParticipantById(migrated.participantId)).isLegacy,
      true,
    );

    await assert.rejects(
      store.saveSentence({
        sentence: "An unknown participant must still fail after migration.",
        challengeId: "mixed",
        participantId: 999_999,
      }),
      /foreign key|participant/i,
    );
    assert.equal(await store.count(), 1);
  } finally {
    await store.close();
  }
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
  await assert.rejects(store.countParticipants(), /closed/);
  await assert.rejects(store.getParticipantById(1), /closed/);
  await assert.rejects(store.createParticipant(participantInput()), /closed/);
  await assert.rejects(store.revokeParticipantSession("a".repeat(64)), /closed/);
  await assert.rejects(
    store.saveSentence({ sentence: "Too late", challengeId: "mixed", participantId: 1 }),
    /closed/,
  );
  await assert.rejects(
    store.saveScaleResult({
      submissionId: 1,
      participantId: 1,
      placements: [{ tokenIndex: 0, tokenText: "Too", rating: 0 }],
      challengePassed: false,
    }),
    /closed/,
  );
  await assert.rejects(
    store.completeChallenge({ submissionId: 1, participantId: 1 }),
    /closed/,
  );
});
