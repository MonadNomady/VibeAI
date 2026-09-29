import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

const CHALLENGE_IDS = new Set(["sarcasm", "clear-vibe", "mixed"]);
const MAX_SENTENCE_LENGTH = 240;

function normalizeSentence(sentence) {
  if (typeof sentence !== "string") {
    throw new TypeError("sentence must be a string");
  }

  const normalized = sentence.trim();
  if (normalized.length === 0) {
    throw new RangeError("sentence must not be empty");
  }

  if (normalized.includes("\0")) {
    throw new RangeError("sentence must not contain null characters");
  }

  if ([...normalized].length > MAX_SENTENCE_LENGTH) {
    throw new RangeError(`sentence must be ${MAX_SENTENCE_LENGTH} characters or fewer`);
  }

  return normalized;
}

function validateChallengeId(challengeId) {
  if (!CHALLENGE_IDS.has(challengeId)) {
    throw new RangeError("challengeId must be sarcasm, clear-vibe, or mixed");
  }

  return challengeId;
}

function validateId(id) {
  if (!Number.isSafeInteger(id) || id < 1) {
    throw new RangeError("id must be a positive integer");
  }

  return id;
}

function normalizeRow(row) {
  if (row === undefined) return null;

  return {
    id: Number(row.id),
    sentence: row.sentence,
    challengeId: row.challenge_id,
    createdAt: row.created_at,
  };
}

export function createSentenceStore(databasePath) {
  if (typeof databasePath !== "string" || databasePath.length === 0) {
    throw new TypeError("databasePath must be a non-empty string");
  }

  const resolvedPath = databasePath === ":memory:" ? databasePath : resolve(databasePath);
  if (resolvedPath !== ":memory:") {
    mkdirSync(dirname(resolvedPath), { recursive: true });
  }

  const database = new DatabaseSync(resolvedPath);

  try {
    database.exec("PRAGMA journal_mode = WAL");
    database.exec("PRAGMA synchronous = NORMAL");
    database.exec("PRAGMA busy_timeout = 5000");
    database.exec("PRAGMA foreign_keys = ON");
    database.exec(`
      CREATE TABLE IF NOT EXISTS sentence_submissions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        sentence TEXT NOT NULL CHECK (length(sentence) BETWEEN 1 AND ${MAX_SENTENCE_LENGTH}),
        challenge_id TEXT NOT NULL CHECK (challenge_id IN ('sarcasm', 'clear-vibe', 'mixed')),
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
      ) STRICT
    `);
  } catch (error) {
    database.close();
    throw error;
  }

  const insertSentence = database.prepare(`
    INSERT INTO sentence_submissions (sentence, challenge_id)
    VALUES (?, ?)
  `);
  const selectById = database.prepare(`
    SELECT id, sentence, challenge_id, created_at
    FROM sentence_submissions
    WHERE id = ?
  `);
  const selectCount = database.prepare(`
    SELECT count(*) AS count
    FROM sentence_submissions
  `);

  let closed = false;

  function assertOpen() {
    if (closed) throw new Error("sentence store is closed");
  }

  return {
    saveSentence({ sentence, challengeId } = {}) {
      assertOpen();
      const normalizedSentence = normalizeSentence(sentence);
      const normalizedChallengeId = validateChallengeId(challengeId);
      const result = insertSentence.run(normalizedSentence, normalizedChallengeId);
      return normalizeRow(selectById.get(result.lastInsertRowid));
    },

    getById(id) {
      assertOpen();
      return normalizeRow(selectById.get(validateId(id)));
    },

    count() {
      assertOpen();
      return Number(selectCount.get().count);
    },

    close() {
      if (closed) return;
      database.close();
      closed = true;
    },
  };
}
