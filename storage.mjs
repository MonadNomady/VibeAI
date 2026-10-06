import pg from "pg";

const { Pool } = pg;

const CHALLENGE_IDS = new Set(["sarcasm", "clear-vibe", "mixed"]);
const MAX_SENTENCE_LENGTH = 240;
const DEFAULT_POOL_SIZE = 3;

const CREATE_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS sentence_submissions (
    id SERIAL PRIMARY KEY,
    sentence VARCHAR(${MAX_SENTENCE_LENGTH}) NOT NULL CHECK (sentence <> ''),
    challenge_id TEXT NOT NULL CHECK (challenge_id IN ('sarcasm', 'clear-vibe', 'mixed')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
  )
`;

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

function normalizeTimestamp(value) {
  const timestamp = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(timestamp.getTime())) {
    throw new TypeError("database returned an invalid creation timestamp");
  }
  return timestamp.toISOString();
}

function normalizeRow(row) {
  if (row === undefined) return null;

  return {
    id: Number(row.id),
    sentence: row.sentence,
    challengeId: row.challenge_id,
    createdAt: normalizeTimestamp(row.created_at),
  };
}

export function databaseUrlFromEnvironment(environment = process.env) {
  for (const connectionString of [environment.DATABASE_URL, environment.POSTGRESQL_ADDON_URI]) {
    if (typeof connectionString === "string" && connectionString.trim().length > 0) {
      return connectionString.trim();
    }
  }
  throw new Error(
    "DATABASE_URL must be set to the Clever Cloud PostgreSQL connection URI.",
  );
}

export async function createSentenceStore({ connectionString, pool } = {}) {
  if (
    pool === undefined
    && (typeof connectionString !== "string" || connectionString.trim().length === 0)
  ) {
    throw new TypeError("connectionString must be a non-empty PostgreSQL connection URI");
  }

  const database = pool ?? new Pool({
    connectionString: connectionString.trim(),
    max: DEFAULT_POOL_SIZE,
    connectionTimeoutMillis: 10_000,
    idleTimeoutMillis: 30_000,
    statement_timeout: 10_000,
    query_timeout: 12_000,
  });

  if (typeof database.query !== "function" || typeof database.end !== "function") {
    throw new TypeError("pool must provide query() and end() methods");
  }

  const onPoolError = (error) => {
    console.error("Unexpected PostgreSQL connection error:", error);
  };
  database.on?.("error", onPoolError);

  try {
    await database.query(CREATE_TABLE_SQL);
    if (pool === undefined) {
      try {
        const transport = await database.query(
          "SELECT ssl FROM pg_stat_ssl WHERE pid = pg_backend_pid()",
        );
        if (transport.rows[0]?.ssl === true) {
          console.log("PostgreSQL transport security: TLS enabled.");
        } else {
          console.warn(
            "PostgreSQL transport security: TLS is not enabled. Do not collect private data.",
          );
        }
      } catch {
        console.warn("PostgreSQL transport security could not be verified.");
      }
    }
  } catch (error) {
    await Promise.resolve().then(() => database.end()).catch(() => {});
    database.off?.("error", onPoolError);
    throw error;
  }

  let closePromise;

  function assertOpen() {
    if (closePromise) throw new Error("sentence store is closed");
  }

  return {
    async saveSentence({ sentence, challengeId } = {}) {
      assertOpen();
      const normalizedSentence = normalizeSentence(sentence);
      const normalizedChallengeId = validateChallengeId(challengeId);
      const result = await database.query(
        `
          INSERT INTO sentence_submissions (sentence, challenge_id)
          VALUES ($1, $2)
          RETURNING id, sentence, challenge_id, created_at
        `,
        [normalizedSentence, normalizedChallengeId],
      );
      return normalizeRow(result.rows[0]);
    },

    async getById(id) {
      assertOpen();
      const result = await database.query(
        `
          SELECT id, sentence, challenge_id, created_at
          FROM sentence_submissions
          WHERE id = $1
        `,
        [validateId(id)],
      );
      return normalizeRow(result.rows[0]);
    },

    async count() {
      assertOpen();
      const result = await database.query(
        "SELECT count(*)::integer AS count FROM sentence_submissions",
      );
      return Number(result.rows[0].count);
    },

    close() {
      if (!closePromise) {
        closePromise = Promise.resolve()
          .then(() => database.end())
          .finally(() => database.off?.("error", onPoolError));
      }
      return closePromise;
    },
  };
}
