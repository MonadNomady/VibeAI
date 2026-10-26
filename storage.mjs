import pg from "pg";

const { Pool } = pg;

const CHALLENGE_IDS = new Set(["sarcasm", "clear-vibe", "mixed"]);
const MAX_SENTENCE_LENGTH = 240;
const MAX_DISPLAY_NAME_LENGTH = 40;
const MAX_SCALE_PLACEMENTS = MAX_SENTENCE_LENGTH;
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
    initial_challenge_passed BOOLEAN,
    challenge_passed BOOLEAN,
    challenge_completed_at TIMESTAMPTZ,
    vibe_confidence_percent SMALLINT CHECK (
      vibe_confidence_percent BETWEEN 0 AND 100
    ),
    scale_submitted_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
  )
`;

const ADD_PARTICIPANT_COLUMN_SQL = `
  ALTER TABLE sentence_submissions
  ADD COLUMN IF NOT EXISTS participant_id BIGINT
`;

const ADD_CHALLENGE_PASSED_COLUMN_SQL = `
  ALTER TABLE sentence_submissions
  ADD COLUMN IF NOT EXISTS challenge_passed BOOLEAN
`;

const ADD_INITIAL_CHALLENGE_PASSED_COLUMN_SQL = `
  ALTER TABLE sentence_submissions
  ADD COLUMN IF NOT EXISTS initial_challenge_passed BOOLEAN
`;

const ADD_CHALLENGE_COMPLETED_COLUMN_SQL = `
  ALTER TABLE sentence_submissions
  ADD COLUMN IF NOT EXISTS challenge_completed_at TIMESTAMPTZ
`;

const ADD_SCALE_SUBMITTED_COLUMN_SQL = `
  ALTER TABLE sentence_submissions
  ADD COLUMN IF NOT EXISTS scale_submitted_at TIMESTAMPTZ
`;

const ADD_VIBE_CONFIDENCE_COLUMN_SQL = `
  ALTER TABLE sentence_submissions
  ADD COLUMN IF NOT EXISTS vibe_confidence_percent SMALLINT CHECK (
    vibe_confidence_percent BETWEEN 0 AND 100
  )
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

const CREATE_VIBE_SCALE_PLACEMENTS_SQL = `
  CREATE TABLE IF NOT EXISTS vibe_scale_placements (
    submission_id BIGINT NOT NULL,
    token_index SMALLINT NOT NULL CHECK (token_index >= 0),
    token_text VARCHAR(${MAX_SENTENCE_LENGTH}) NOT NULL CHECK (token_text <> ''),
    rating SMALLINT NOT NULL CHECK (rating IN (-1, 0, 1)),
    PRIMARY KEY (submission_id, token_index),
    CONSTRAINT vibe_scale_placements_submission_fk
      FOREIGN KEY (submission_id) REFERENCES sentence_submissions(id) ON DELETE CASCADE
  )
`;

const CREATE_TWEAK_ATTEMPTS_SQL = `
  CREATE TABLE IF NOT EXISTS tweak_attempts (
    id BIGSERIAL PRIMARY KEY,
    submission_id BIGINT NOT NULL,
    attempt_index INTEGER NOT NULL CHECK (attempt_index > 0),
    token_index SMALLINT NOT NULL CHECK (token_index >= 0),
    original_token VARCHAR(${MAX_SENTENCE_LENGTH}) NOT NULL CHECK (original_token <> ''),
    replacement_text VARCHAR(${MAX_SENTENCE_LENGTH}) NOT NULL CHECK (replacement_text <> ''),
    before_sentence VARCHAR(${MAX_SENTENCE_LENGTH}) NOT NULL CHECK (before_sentence <> ''),
    after_sentence VARCHAR(${MAX_SENTENCE_LENGTH}) NOT NULL CHECK (after_sentence <> ''),
    before_score DOUBLE PRECISION NOT NULL CHECK (before_score BETWEEN -1 AND 1),
    after_score DOUBLE PRECISION NOT NULL CHECK (after_score BETWEEN -1 AND 1),
    challenge_passed BOOLEAN NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (submission_id, attempt_index),
    CONSTRAINT tweak_attempts_submission_fk
      FOREIGN KEY (submission_id) REFERENCES sentence_submissions(id) ON DELETE CASCADE
  )
`;

export class TweakSequenceConflictError extends Error {
  constructor(currentSentence, challengePassed) {
    super("The Tweak Lab sentence changed before this attempt could be saved.");
    this.name = "TweakSequenceConflictError";
    this.currentSentence = currentSentence;
    this.challengePassed = challengePassed;
  }
}

export function normalizeSentence(sentence) {
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

function normalizeScalePlacements(placements) {
  if (!Array.isArray(placements) || placements.length === 0) {
    throw new TypeError("placements must be a non-empty array");
  }
  if (placements.length > MAX_SCALE_PLACEMENTS) {
    throw new RangeError(`placements must contain at most ${MAX_SCALE_PLACEMENTS} tokens`);
  }

  return placements.map((placement, expectedIndex) => {
    if (!placement || Array.isArray(placement) || typeof placement !== "object") {
      throw new TypeError("each placement must be an object");
    }
    if (placement.tokenIndex !== expectedIndex) {
      throw new RangeError("placement token indexes must be contiguous and start at zero");
    }
    if (typeof placement.tokenText !== "string" || placement.tokenText.length === 0) {
      throw new TypeError("placement tokenText must be a non-empty string");
    }
    if (placement.tokenText.includes("\0")) {
      throw new RangeError("placement tokenText must not contain null characters");
    }
    if ([...placement.tokenText].length > MAX_SENTENCE_LENGTH) {
      throw new RangeError(`placement tokenText must be ${MAX_SENTENCE_LENGTH} characters or fewer`);
    }
    if (!Number.isInteger(placement.rating) || ![-1, 0, 1].includes(placement.rating)) {
      throw new RangeError("placement rating must be -1, 0, or 1");
    }

    return Object.freeze({
      tokenIndex: expectedIndex,
      tokenText: placement.tokenText,
      rating: placement.rating,
    });
  });
}

function validateChallengePassed(challengePassed) {
  if (typeof challengePassed !== "boolean") {
    throw new TypeError("challengePassed must be a boolean");
  }
  return challengePassed;
}

function validateVibeConfidencePercent(vibeConfidencePercent) {
  if (
    !Number.isInteger(vibeConfidencePercent)
    || vibeConfidencePercent < 0
    || vibeConfidencePercent > 100
  ) {
    throw new RangeError("vibeConfidencePercent must be an integer from 0 to 100");
  }
  return vibeConfidencePercent;
}

function normalizeTweakText(value, name) {
  if (typeof value !== "string") {
    throw new TypeError(`${name} must be a string`);
  }
  const normalized = value.trim();
  if (!normalized) {
    throw new RangeError(`${name} must not be empty`);
  }
  if (normalized.includes("\0")) {
    throw new RangeError(`${name} must not contain null characters`);
  }
  if ([...normalized].length > MAX_SENTENCE_LENGTH) {
    throw new RangeError(`${name} must be ${MAX_SENTENCE_LENGTH} characters or fewer`);
  }
  return normalized;
}

function validateTweakTokenIndex(tokenIndex) {
  if (
    !Number.isSafeInteger(tokenIndex)
    || tokenIndex < 0
    || tokenIndex >= MAX_SCALE_PLACEMENTS
  ) {
    throw new RangeError("tokenIndex must identify a displayed token");
  }
  return tokenIndex;
}

function validateSentimentScore(score, name) {
  if (!Number.isFinite(score) || score < -1 || score > 1) {
    throw new RangeError(`${name} must be a finite number from -1 to 1`);
  }
  return score;
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
    initialChallengePassed: row.initial_challenge_passed == null
      ? null
      : row.initial_challenge_passed === true,
    challengePassed: row.challenge_passed == null ? null : row.challenge_passed === true,
    challengeCompletedAt: row.challenge_completed_at == null
      ? null
      : normalizeTimestamp(row.challenge_completed_at),
    vibeConfidencePercent: row.vibe_confidence_percent == null
      ? null
      : Number(row.vibe_confidence_percent),
    scaleSubmittedAt: row.scale_submitted_at == null
      ? null
      : normalizeTimestamp(row.scale_submitted_at),
    createdAt: normalizeTimestamp(row.created_at),
    wordPlacements: [],
  };
}

function normalizePlacementRow(row) {
  return {
    tokenIndex: normalizeDatabaseId(row.token_index, "token index"),
    tokenText: row.token_text,
    rating: Number(row.rating),
  };
}

function normalizeTweakAttemptRow(row) {
  if (row === undefined) return null;
  return {
    id: normalizeDatabaseId(row.id, "tweak attempt id"),
    submissionId: normalizeDatabaseId(row.submission_id, "submission id"),
    attemptIndex: normalizeDatabaseId(row.attempt_index, "attempt index"),
    tokenIndex: normalizeDatabaseId(row.token_index, "token index"),
    originalToken: row.original_token,
    replacementText: row.replacement_text,
    beforeSentence: row.before_sentence,
    afterSentence: row.after_sentence,
    beforeScore: Number(row.before_score),
    afterScore: Number(row.after_score),
    attemptPassed: row.challenge_passed === true,
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
    await client.query(ADD_INITIAL_CHALLENGE_PASSED_COLUMN_SQL);
    await client.query(ADD_CHALLENGE_PASSED_COLUMN_SQL);
    await client.query(ADD_CHALLENGE_COMPLETED_COLUMN_SQL);
    await client.query(ADD_VIBE_CONFIDENCE_COLUMN_SQL);
    await client.query(ADD_SCALE_SUBMITTED_COLUMN_SQL);
    // Preserve results if this app version briefly ran with only challenge_passed.
    await client.query(
      `
        UPDATE sentence_submissions
        SET initial_challenge_passed = challenge_passed
        WHERE initial_challenge_passed IS NULL
          AND challenge_passed IS NOT NULL
          AND scale_submitted_at IS NOT NULL
      `,
    );
    await client.query(
      `
        UPDATE sentence_submissions
        SET challenge_completed_at = scale_submitted_at
        WHERE challenge_completed_at IS NULL
          AND challenge_passed = TRUE
          AND scale_submitted_at IS NOT NULL
      `,
    );
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
    await client.query(CREATE_VIBE_SCALE_PLACEMENTS_SQL);
    await client.query(CREATE_TWEAK_ATTEMPTS_SQL);
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
          RETURNING
            id,
            participant_id,
            sentence,
            challenge_id,
            initial_challenge_passed,
            challenge_passed,
            challenge_completed_at,
            vibe_confidence_percent,
            scale_submitted_at,
            created_at
        `,
        [normalizedParticipantId, normalizedSentence, normalizedChallengeId],
      );
      return normalizeSubmissionRow(result.rows[0]);
    },

    async getById(id) {
      assertOpen();
      const result = await database.query(
        `
          SELECT
            id,
            participant_id,
            sentence,
            challenge_id,
            initial_challenge_passed,
            challenge_passed,
            challenge_completed_at,
            vibe_confidence_percent,
            scale_submitted_at,
            created_at
          FROM sentence_submissions
          WHERE id = $1
        `,
        [validatePositiveId(id)],
      );
      const submission = normalizeSubmissionRow(result.rows[0]);
      if (!submission) return null;

      const placementResult = await database.query(
        `
          SELECT token_index, token_text, rating
          FROM vibe_scale_placements
          WHERE submission_id = $1
          ORDER BY token_index
        `,
        [submission.id],
      );
      submission.wordPlacements = placementResult.rows.map(normalizePlacementRow);
      return submission;
    },

    async saveScaleResult({
      submissionId,
      participantId,
      placements,
      challengePassed,
      vibeConfidencePercent,
    } = {}) {
      assertOpen();
      const normalizedSubmissionId = validatePositiveId(submissionId, "submissionId");
      const normalizedParticipantId = validatePositiveId(participantId, "participantId");
      const normalizedPlacements = normalizeScalePlacements(placements);
      const normalizedPassed = validateChallengePassed(challengePassed);
      const normalizedConfidence = validateVibeConfidencePercent(vibeConfidencePercent);
      const client = await database.connect();

      try {
        await client.query("BEGIN");
        const updated = await client.query(
          `
            UPDATE sentence_submissions
            SET initial_challenge_passed = COALESCE(initial_challenge_passed, $3),
                challenge_passed = COALESCE(challenge_passed, FALSE) OR $3,
                challenge_completed_at = CASE
                  WHEN challenge_completed_at IS NOT NULL THEN challenge_completed_at
                  WHEN $3 THEN CURRENT_TIMESTAMP::TIMESTAMPTZ
                  ELSE NULL
                END,
                vibe_confidence_percent = $4,
                scale_submitted_at = COALESCE(
                  scale_submitted_at,
                  CURRENT_TIMESTAMP::TIMESTAMPTZ
                )
            WHERE id = $1 AND participant_id = $2
            RETURNING
              id,
              participant_id,
              sentence,
              challenge_id,
              initial_challenge_passed,
              challenge_passed,
              challenge_completed_at,
              vibe_confidence_percent,
              scale_submitted_at,
              created_at
          `,
          [
            normalizedSubmissionId,
            normalizedParticipantId,
            normalizedPassed,
            normalizedConfidence,
          ],
        );

        if (updated.rows.length === 0) {
          await client.query("ROLLBACK");
          return null;
        }

        await client.query(
          "DELETE FROM vibe_scale_placements WHERE submission_id = $1",
          [normalizedSubmissionId],
        );

        const values = [];
        const placeholders = normalizedPlacements.map((placement, index) => {
          const offset = index * 4;
          values.push(
            normalizedSubmissionId,
            placement.tokenIndex,
            placement.tokenText,
            placement.rating,
          );
          return `($${offset + 1}, $${offset + 2}, $${offset + 3}, $${offset + 4})`;
        });
        await client.query(
          `
            INSERT INTO vibe_scale_placements (
              submission_id,
              token_index,
              token_text,
              rating
            )
            VALUES ${placeholders.join(", ")}
          `,
          values,
        );
        await client.query("COMMIT");

        return {
          ...normalizeSubmissionRow(updated.rows[0]),
          wordPlacements: normalizedPlacements,
        };
      } catch (error) {
        await client.query("ROLLBACK").catch(() => {});
        throw error;
      } finally {
        client.release();
      }
    },

    async completeChallenge({ submissionId, participantId } = {}) {
      assertOpen();
      const normalizedSubmissionId = validatePositiveId(submissionId, "submissionId");
      const normalizedParticipantId = validatePositiveId(participantId, "participantId");
      const result = await database.query(
        `
          UPDATE sentence_submissions
          SET challenge_passed = TRUE,
              challenge_completed_at = COALESCE(
                challenge_completed_at,
                CURRENT_TIMESTAMP::TIMESTAMPTZ
              )
          WHERE id = $1
            AND participant_id = $2
            AND initial_challenge_passed IS NOT NULL
          RETURNING
            id,
            participant_id,
            sentence,
            challenge_id,
            initial_challenge_passed,
            challenge_passed,
            challenge_completed_at,
            vibe_confidence_percent,
            scale_submitted_at,
            created_at
        `,
        [normalizedSubmissionId, normalizedParticipantId],
      );
      return normalizeSubmissionRow(result.rows[0]);
    },

    async saveTweakAttempt({
      submissionId,
      participantId,
      beforeSentence,
      afterSentence,
      tokenIndex,
      originalToken,
      replacementText,
      beforeScore,
      afterScore,
      attemptPassed,
    } = {}) {
      assertOpen();
      const normalizedSubmissionId = validatePositiveId(submissionId, "submissionId");
      const normalizedParticipantId = validatePositiveId(participantId, "participantId");
      const normalizedBeforeSentence = normalizeTweakText(beforeSentence, "beforeSentence");
      const normalizedAfterSentence = normalizeTweakText(afterSentence, "afterSentence");
      const normalizedTokenIndex = validateTweakTokenIndex(tokenIndex);
      const normalizedOriginalToken = normalizeTweakText(originalToken, "originalToken");
      const normalizedReplacement = normalizeTweakText(replacementText, "replacementText");
      const normalizedBeforeScore = validateSentimentScore(beforeScore, "beforeScore");
      const normalizedAfterScore = validateSentimentScore(afterScore, "afterScore");
      const normalizedAttemptPassed = validateChallengePassed(attemptPassed);
      const client = await database.connect();

      try {
        await client.query("BEGIN");
        const submissionResult = await client.query(
          `
            SELECT sentence, challenge_passed, challenge_completed_at
            FROM sentence_submissions
            WHERE id = $1
              AND participant_id = $2
              AND initial_challenge_passed IS NOT NULL
            FOR UPDATE
          `,
          [normalizedSubmissionId, normalizedParticipantId],
        );
        if (submissionResult.rows.length === 0) {
          await client.query("ROLLBACK");
          return null;
        }

        const latestResult = await client.query(
          `
            SELECT attempt_index, after_sentence
            FROM tweak_attempts
            WHERE submission_id = $1
            ORDER BY attempt_index DESC
            LIMIT 1
          `,
          [normalizedSubmissionId],
        );
        const latest = latestResult.rows[0];
        const currentSentence = latest?.after_sentence ?? submissionResult.rows[0].sentence;
        if (currentSentence !== normalizedBeforeSentence) {
          await client.query("ROLLBACK");
          throw new TweakSequenceConflictError(
            currentSentence,
            submissionResult.rows[0].challenge_passed === true,
          );
        }

        const attemptIndex = latest ? Number(latest.attempt_index) + 1 : 1;
        const inserted = await client.query(
          `
            INSERT INTO tweak_attempts (
              submission_id,
              attempt_index,
              token_index,
              original_token,
              replacement_text,
              before_sentence,
              after_sentence,
              before_score,
              after_score,
              challenge_passed
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
            RETURNING
              id,
              submission_id,
              attempt_index,
              token_index,
              original_token,
              replacement_text,
              before_sentence,
              after_sentence,
              before_score,
              after_score,
              challenge_passed,
              created_at
          `,
          [
            normalizedSubmissionId,
            attemptIndex,
            normalizedTokenIndex,
            normalizedOriginalToken,
            normalizedReplacement,
            normalizedBeforeSentence,
            normalizedAfterSentence,
            normalizedBeforeScore,
            normalizedAfterScore,
            normalizedAttemptPassed,
          ],
        );

        let overallChallengePassed = submissionResult.rows[0].challenge_passed === true;
        let challengeCompletedAt = submissionResult.rows[0].challenge_completed_at;
        if (normalizedAttemptPassed) {
          const completed = await client.query(
            `
              UPDATE sentence_submissions
              SET challenge_passed = TRUE,
                  challenge_completed_at = COALESCE(
                    challenge_completed_at,
                    CURRENT_TIMESTAMP::TIMESTAMPTZ
                  )
              WHERE id = $1 AND participant_id = $2
              RETURNING challenge_passed, challenge_completed_at
            `,
            [normalizedSubmissionId, normalizedParticipantId],
          );
          overallChallengePassed = completed.rows[0].challenge_passed === true;
          challengeCompletedAt = completed.rows[0].challenge_completed_at;
        }

        await client.query("COMMIT");
        return {
          ...normalizeTweakAttemptRow(inserted.rows[0]),
          overallChallengePassed,
          challengeCompletedAt: challengeCompletedAt == null
            ? null
            : normalizeTimestamp(challengeCompletedAt),
        };
      } catch (error) {
        await client.query("ROLLBACK").catch(() => {});
        throw error;
      } finally {
        client.release();
      }
    },

    async getTweakAttempts(submissionId) {
      assertOpen();
      const result = await database.query(
        `
          SELECT
            id,
            submission_id,
            attempt_index,
            token_index,
            original_token,
            replacement_text,
            before_sentence,
            after_sentence,
            before_score,
            after_score,
            challenge_passed,
            created_at
          FROM tweak_attempts
          WHERE submission_id = $1
          ORDER BY attempt_index
        `,
        [validatePositiveId(submissionId, "submissionId")],
      );
      return result.rows.map(normalizeTweakAttemptRow);
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
