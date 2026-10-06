import pg from "pg";

const { Pool } = pg;

const CHALLENGE_IDS = new Set(["sarcasm", "clear-vibe", "mixed"]);
const MAX_SENTENCE_LENGTH = 240;
const MAX_DISPLAY_NAME_LENGTH = 40;
const DEFAULT_POOL_SIZE = 3;

const CREATE_PARTICIPANTS_SQL = `
  CREATE TABLE IF NOT EXISTS participants (
    id BIGSERIAL PRIMARY KEY,
    display_name VARCHAR(${MAX_DISPLAY_NAME_LENGTH}) NOT NULL CHECK (display_name <> ''),
    session_token_hash VARCHAR(64) UNIQUE,
    session_expires_at TIMESTAMPTZ,
    is_legacy BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CHECK (
      (is_legacy = TRUE AND session_token_hash IS NULL AND session_expires_at IS NULL)
      OR
      (is_legacy = FALSE AND session_token_hash IS NOT NULL AND session_expires_at IS NOT NULL)
    )
  )
`;

const CREATE_SUBMISSIONS_SQL = `
  CREATE TABLE IF NOT EXISTS sentence_submissions (
    id BIGSERIAL PRIMARY KEY,
    participant_id BIGINT NOT NULL,
    sentence VARCHAR(${MAX_SENTENCE_LENGTH}) NOT NULL CHECK (sentence <> ''),
    challenge_id TEXT NOT NULL CHECK (challenge_id IN ('sarcasm', 'clear-vibe', 'mixed')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
  )
`;

const ADD_PARTICIPANT_COLUMN_SQL = `
  ALTER TABLE sentence_submissions
  ADD COLUMN IF NOT EXISTS participant_id BIGINT
`;

const DROP_PARTICIPANT_FOREIGN_KEY_SQL = `
  ALTER TABLE sentence_submissions
  DROP CONSTRAINT IF EXISTS sentence_submissions_participant_fk
`;

const ADD_PARTICIPANT_FOREIGN_KEY_SQL = `
  ALTER TABLE sentence_submissions
  ADD CONSTRAINT sentence_submissions_participant_fk
  FOREIGN KEY (participant_id) REFERENCES participants(id) ON DELETE RESTRICT
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

export function normalizeDisplayName(displayName) {
  if (typeof displayName !== "string") {
    throw new TypeError("displayName must be a string");
  }
  if (typeof displayName.isWellFormed === "function" && !displayName.isWellFormed()) {
    throw new RangeError("displayName must contain valid Unicode text");
  }
  if (/[\p{Cc}\p{Cf}]/u.test(displayName)) {
    throw new RangeError("displayName must not contain control characters");
  }

  const normalized = displayName.normalize("NFC").trim().replace(/\s+/gu, " ");
  if (!normalized) {
    throw new RangeError("displayName must not be empty");
  }
  if ([...normalized].length > MAX_DISPLAY_NAME_LENGTH) {
    throw new RangeError(
      `displayName must be ${MAX_DISPLAY_NAME_LENGTH} characters or fewer`,
    );
  }
  return normalized;
}

function validateChallengeId(challengeId) {
  if (!CHALLENGE_IDS.has(challengeId)) {
    throw new RangeError("challengeId must be sarcasm, clear-vibe, or mixed");
  }
  return challengeId;
}

function validatePositiveId(id, name = "id") {
  if (!Number.isSafeInteger(id) || id < 1) {
    throw new RangeError(`${name} must be a positive integer`);
  }
  return id;
}

function validateParticipantLookupId(id) {
  if (!Number.isSafeInteger(id) || id < 0) {
    throw new RangeError("participantId must be a non-negative integer");
  }
  return id;
}

function validateSessionHash(sessionTokenHash) {
  if (typeof sessionTokenHash !== "string" || !/^[a-f0-9]{64}$/.test(sessionTokenHash)) {
    throw new RangeError("sessionTokenHash must be a lowercase SHA-256 hash");
  }
  return sessionTokenHash;
}

function validateSessionExpiry(sessionExpiresAt) {
  const expiry = sessionExpiresAt instanceof Date
    ? new Date(sessionExpiresAt.getTime())
    : new Date(sessionExpiresAt);
  if (Number.isNaN(expiry.getTime())) {
    throw new TypeError("sessionExpiresAt must be a valid date");
  }
  return expiry;
}

function normalizeTimestamp(value) {
  const timestamp = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(timestamp.getTime())) {
    throw new TypeError("database returned an invalid creation timestamp");
  }
  return timestamp.toISOString();
}

function normalizeDatabaseId(value, name) {
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id < 0) {
    throw new TypeError(`database returned an invalid ${name}`);
  }
  return id;
}

function normalizeParticipantRow(row) {
  if (row === undefined) return null;
  return {
    id: normalizeDatabaseId(row.id, "participant id"),
    displayName: row.display_name,
    createdAt: normalizeTimestamp(row.created_at),
    isLegacy: row.is_legacy === true,
  };
}

function normalizeSubmissionRow(row) {
  if (row === undefined) return null;
  return {
    id: normalizeDatabaseId(row.id, "submission id"),
    participantId: normalizeDatabaseId(row.participant_id, "participant id"),
    sentence: row.sentence,
    challengeId: row.challenge_id,
    createdAt: normalizeTimestamp(row.created_at),
  };
}

async function initializeSchema(database) {
  if (typeof database.connect !== "function") {
    throw new TypeError("pool must provide connect() for schema migrations");
  }

  const client = await database.connect();
  try {
    await client.query("BEGIN");
    await client.query(CREATE_PARTICIPANTS_SQL);
    await client.query(
      `
        INSERT INTO participants (id, display_name, is_legacy)
        VALUES (0, 'Before names were collected', TRUE)
        ON CONFLICT (id) DO NOTHING
      `,
    );
    await client.query(CREATE_SUBMISSIONS_SQL);
    await client.query(ADD_PARTICIPANT_COLUMN_SQL);
    await client.query(
      "UPDATE sentence_submissions SET participant_id = 0 WHERE participant_id IS NULL",
    );
    await client.query(
      "ALTER TABLE sentence_submissions ALTER COLUMN participant_id SET NOT NULL",
    );
    // Recreate a predictable named constraint so partially applied/manual schemas
    // cannot leave participant_id present without referential integrity.
    await client.query(DROP_PARTICIPANT_FOREIGN_KEY_SQL);
    await client.query(ADD_PARTICIPANT_FOREIGN_KEY_SQL);
    await client.query(
      `
        CREATE INDEX IF NOT EXISTS sentence_submissions_participant_created_idx
        ON sentence_submissions (participant_id, created_at DESC)
      `,
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
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

  if (
    typeof database.query !== "function"
    || typeof database.connect !== "function"
    || typeof database.end !== "function"
  ) {
    throw new TypeError("pool must provide query(), connect(), and end() methods");
  }

  const onPoolError = (error) => {
    console.error("Unexpected PostgreSQL connection error:", error);
  };
  database.on?.("error", onPoolError);

  try {
    await initializeSchema(database);
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
    async createParticipant({ displayName, sessionTokenHash, sessionExpiresAt } = {}) {
      assertOpen();
      const normalizedName = normalizeDisplayName(displayName);
      const normalizedHash = validateSessionHash(sessionTokenHash);
      const normalizedExpiry = validateSessionExpiry(sessionExpiresAt);
      const result = await database.query(
        `
          INSERT INTO participants (
            display_name,
            session_token_hash,
            session_expires_at
          )
          VALUES ($1, $2, $3)
          RETURNING id, display_name, created_at, is_legacy
        `,
        [normalizedName, normalizedHash, normalizedExpiry],
      );
      return normalizeParticipantRow(result.rows[0]);
    },

    async getParticipantBySessionHash(sessionTokenHash) {
      assertOpen();
      const result = await database.query(
        `
          SELECT id, display_name, created_at, is_legacy
          FROM participants
          WHERE session_token_hash = $1
            AND is_legacy = FALSE
            AND session_expires_at > $2
        `,
        [validateSessionHash(sessionTokenHash), new Date()],
      );
      return normalizeParticipantRow(result.rows[0]);
    },

    async revokeParticipantSession(sessionTokenHash) {
      assertOpen();
      const result = await database.query(
        `
          UPDATE participants
          SET session_expires_at = CURRENT_TIMESTAMP
          WHERE session_token_hash = $1
            AND is_legacy = FALSE
          RETURNING id
        `,
        [validateSessionHash(sessionTokenHash)],
      );
      return result.rows.length > 0;
    },

    async getParticipantById(id) {
      assertOpen();
      const result = await database.query(
        `
          SELECT id, display_name, created_at, is_legacy
          FROM participants
          WHERE id = $1
        `,
        [validateParticipantLookupId(id)],
      );
      return normalizeParticipantRow(result.rows[0]);
    },

    async saveSentence({ sentence, challengeId, participantId } = {}) {
      assertOpen();
      const normalizedSentence = normalizeSentence(sentence);
      const normalizedChallengeId = validateChallengeId(challengeId);
      const normalizedParticipantId = validatePositiveId(participantId, "participantId");
      const result = await database.query(
        `
          INSERT INTO sentence_submissions (participant_id, sentence, challenge_id)
          VALUES ($1, $2, $3)
          RETURNING id, participant_id, sentence, challenge_id, created_at
        `,
        [normalizedParticipantId, normalizedSentence, normalizedChallengeId],
      );
      return normalizeSubmissionRow(result.rows[0]);
    },

    async getById(id) {
      assertOpen();
      const result = await database.query(
        `
          SELECT id, participant_id, sentence, challenge_id, created_at
          FROM sentence_submissions
          WHERE id = $1
        `,
        [validatePositiveId(id)],
      );
      return normalizeSubmissionRow(result.rows[0]);
    },

    async count() {
      assertOpen();
      const result = await database.query(
        "SELECT count(*)::integer AS count FROM sentence_submissions",
      );
      return Number(result.rows[0].count);
    },

    async countParticipants() {
      assertOpen();
      const result = await database.query(
        "SELECT count(*)::integer AS count FROM participants WHERE is_legacy = FALSE",
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
