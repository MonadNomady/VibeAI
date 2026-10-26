import { createHash, randomBytes } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { extname, join, resolve } from "node:path";
import {
  TweakSequenceConflictError,
  createSentenceStore,
  databaseUrlFromEnvironment,
  normalizeDisplayName,
  normalizeSentence,
} from "./storage.mjs";
import {
  analyzeSentiment,
  didPassChallenge,
  tokenizeSentence,
} from "./sentiment.js";

const DEFAULT_PORT = 4173;
const MAX_BODY_BYTES = 4_096;
const SESSION_COOKIE_NAME = "vibecheck_session";
const SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 30;
const modulePath = fileURLToPath(import.meta.url);
const defaultRoot = fileURLToPath(new URL(".", import.meta.url));

const publicFiles = new Map([
  ["/", "index.html"],
  ["/index.html", "index.html"],
  ["/app.js", "app.js"],
  ["/emotion-model.js", "emotion-model.js"],
  ["/emotion-worker.js", "emotion-worker.js"],
  ["/sentiment.js", "sentiment.js"],
  ["/styles.css", "styles.css"],
  ["/hampters/anger_hampter.png", "hampters/anger_hampter.png"],
  ["/hampters/disgust_hampter.png", "hampters/disgust_hampter.png"],
  ["/hampters/emotion_placeholder.png", "hampters/emotion_placeholder.png"],
  ["/hampters/fear_hampter.png", "hampters/fear_hampter.png"],
  ["/hampters/joy_hampter.png", "hampters/joy_hampter.png"],
  ["/hampters/neutral_hampter.png", "hampters/neutral_hampter.png"],
  ["/hampters/sadness_hampter.png", "hampters/sadness_hampter.png"],
  ["/hampters/surprise_hampter.png", "hampters/surprise_hampter.png"],
]);

const contentTypes = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".png": "image/png",
};

function listen(server, port) {
  return new Promise((resolveListen, rejectListen) => {
    const onError = (error) => {
      server.off("listening", onListening);
      rejectListen(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolveListen();
    };

    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port);
  });
}

class RequestError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function writeJson(response, status, body, extraHeaders = {}) {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    ...extraHeaders,
  });
  response.end(JSON.stringify(body));
}

function writeNoContent(response, extraHeaders = {}) {
  response.writeHead(204, {
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    ...extraHeaders,
  });
  response.end();
}

function cookieValue(request, name) {
  const header = request.headers.cookie;
  if (typeof header !== "string") return null;

  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0) continue;
    const key = part.slice(0, separator).trim();
    if (key !== name) continue;
    try {
      return decodeURIComponent(part.slice(separator + 1).trim());
    } catch {
      return null;
    }
  }
  return null;
}

function requestUsesHttps(request) {
  if (request.socket.encrypted === true) return true;
  const forwardedProtocol = String(request.headers["x-forwarded-proto"] ?? "")
    .split(",", 1)[0]
    .trim()
    .toLowerCase();
  return forwardedProtocol === "https";
}

function sessionCookie(request, token, { expiresAt, clear = false } = {}) {
  const parts = [
    `${SESSION_COOKIE_NAME}=${clear ? "" : encodeURIComponent(token)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
  ];

  if (clear) {
    parts.push("Max-Age=0", "Expires=Thu, 01 Jan 1970 00:00:00 GMT");
  } else {
    parts.push(`Max-Age=${SESSION_MAX_AGE_SECONDS}`, `Expires=${expiresAt.toUTCString()}`);
  }
  if (requestUsesHttps(request)) parts.push("Secure");
  return parts.join("; ");
}

function hashSessionToken(token) {
  return createHash("sha256").update(token).digest("hex");
}

function publicParticipant(participant) {
  if (!participant) return null;
  return { id: participant.id, displayName: participant.displayName };
}

async function participantSession(request, store) {
  const token = cookieValue(request, SESSION_COOKIE_NAME);
  if (!token) return { participant: null, shouldClear: false };
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) {
    return { participant: null, shouldClear: true };
  }

  const participant = await store.getParticipantBySessionHash(hashSessionToken(token));
  return { participant, shouldClear: participant === null };
}

async function readJsonBody(request) {
  const contentType = request.headers["content-type"]?.split(";", 1)[0].trim().toLowerCase() ?? "";
  if (contentType !== "application/json") {
    throw new RequestError(415, "Content-Type must be application/json.");
  }

  const declaredLength = Number(request.headers["content-length"] ?? 0);
  if (Number.isFinite(declaredLength) && declaredLength > MAX_BODY_BYTES) {
    throw new RequestError(413, "Request body is too large.");
  }

  const chunks = [];
  let totalBytes = 0;
  for await (const chunk of request) {
    totalBytes += chunk.length;
    if (totalBytes > MAX_BODY_BYTES) {
      throw new RequestError(413, "Request body is too large.");
    }
    chunks.push(chunk);
  }

  let body;
  try {
    body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new RequestError(400, "Request body must contain valid JSON.");
  }

  if (body === null || Array.isArray(body) || typeof body !== "object") {
    throw new RequestError(400, "Request body must be a JSON object.");
  }

  return body;
}

function normalizeRatings(ratings, expectedCount) {
  if (!Array.isArray(ratings)) {
    throw new TypeError("ratings must be an array");
  }
  if (ratings.length !== expectedCount) {
    throw new RangeError("ratings must include exactly one value for each displayed token");
  }

  return ratings.map((rating) => {
    if (!Number.isInteger(rating) || ![-1, 0, 1].includes(rating)) {
      throw new RangeError("each rating must be -1, 0, or 1");
    }
    return rating;
  });
}

function normalizeConfidencePercent(confidencePercent) {
  if (
    !Number.isInteger(confidencePercent)
    || confidencePercent < 0
    || confidencePercent > 100
  ) {
    throw new RangeError("confidencePercent must be an integer from 0 to 100");
  }
  return confidencePercent;
}

function normalizeTweakTokenIndex(tokenIndex, tokenCount) {
  if (!Number.isSafeInteger(tokenIndex) || tokenIndex < 0 || tokenIndex >= tokenCount) {
    throw new RangeError("tokenIndex must identify a displayed token");
  }
  return tokenIndex;
}

function normalizeReplacementText(replacementText) {
  if (typeof replacementText !== "string") {
    throw new TypeError("replacementText must be a string");
  }
  const normalized = replacementText.trim();
  if (!normalized) {
    throw new RangeError("replacementText must not be empty");
  }
  if (normalized.includes("\0")) {
    throw new RangeError("replacementText must not contain null characters");
  }
  if ([...normalized].length > 240) {
    throw new RangeError("replacementText must be 240 characters or fewer");
  }
  return normalized;
}

async function handleSessionApi(request, response, store) {
  if (request.method === "DELETE") {
    const token = cookieValue(request, SESSION_COOKIE_NAME);
    if (token && /^[A-Za-z0-9_-]{43}$/.test(token)) {
      await store.revokeParticipantSession(hashSessionToken(token));
    }
    writeNoContent(response, {
      "Set-Cookie": sessionCookie(request, "", { clear: true }),
    });
    return;
  }

  if (request.method !== "GET") {
    writeJson(response, 405, { error: "Method not allowed." }, { Allow: "GET, DELETE" });
    return;
  }

  const session = await participantSession(request, store);
  const headers = session.shouldClear
    ? { "Set-Cookie": sessionCookie(request, "", { clear: true }) }
    : {};
  writeJson(response, 200, { participant: publicParticipant(session.participant) }, headers);
}

async function handleParticipantApi(request, response, store) {
  if (request.method !== "POST") {
    writeJson(response, 405, { error: "Method not allowed." }, { Allow: "POST" });
    return;
  }

  try {
    const body = await readJsonBody(request);
    const displayName = normalizeDisplayName(body.displayName);
    const currentSession = await participantSession(request, store);

    if (currentSession.participant) {
      if (currentSession.participant.displayName === displayName) {
        writeJson(response, 200, {
          participant: publicParticipant(currentSession.participant),
        });
        return;
      }
    }

    const token = randomBytes(32).toString("base64url");
    const expiresAt = new Date(Date.now() + SESSION_MAX_AGE_SECONDS * 1_000);
    const participant = await store.createParticipant({
      displayName,
      sessionTokenHash: hashSessionToken(token),
      sessionExpiresAt: expiresAt,
    });

    writeJson(
      response,
      201,
      { participant: publicParticipant(participant) },
      { "Set-Cookie": sessionCookie(request, token, { expiresAt }) },
    );
  } catch (error) {
    if (error instanceof RequestError) {
      writeJson(response, error.status, { error: error.message });
      return;
    }
    if (error instanceof TypeError || error instanceof RangeError) {
      writeJson(response, 400, { error: error.message });
      return;
    }
    console.error("Failed to create participant:", error);
    writeJson(response, 500, { error: "The classroom name could not be saved." });
  }
}

async function handleSentenceApi(request, response, store) {
  if (request.method !== "POST") {
    writeJson(response, 405, { error: "Method not allowed." }, { Allow: "POST" });
    return;
  }

  try {
    const session = await participantSession(request, store);
    if (!session.participant) {
      const headers = session.shouldClear
        ? { "Set-Cookie": sessionCookie(request, "", { clear: true }) }
        : {};
      writeJson(
        response,
        401,
        { error: "Enter your classroom name before submitting a sentence." },
        headers,
      );
      return;
    }

    const body = await readJsonBody(request);
    const saved = await store.saveSentence({
      sentence: body.sentence,
      challengeId: body.challengeId,
      participantId: session.participant.id,
    });
    writeJson(response, 201, { id: saved.id, createdAt: saved.createdAt });
  } catch (error) {
    if (error instanceof RequestError) {
      writeJson(response, error.status, { error: error.message });
      return;
    }
    if (error instanceof TypeError || error instanceof RangeError) {
      writeJson(response, 400, { error: error.message });
      return;
    }
    console.error("Failed to save sentence submission:", error);
    writeJson(response, 500, { error: "The sentence could not be saved." });
  }
}

async function handleScaleResultApi(request, response, store, submissionId) {
  if (request.method !== "PUT") {
    writeJson(response, 405, { error: "Method not allowed." }, { Allow: "PUT" });
    return;
  }

  try {
    const session = await participantSession(request, store);
    if (!session.participant) {
      const headers = session.shouldClear
        ? { "Set-Cookie": sessionCookie(request, "", { clear: true }) }
        : {};
      writeJson(
        response,
        401,
        { error: "Enter your classroom name before saving vibe-scale choices." },
        headers,
      );
      return;
    }

    const submission = await store.getById(submissionId);
    if (!submission || submission.participantId !== session.participant.id) {
      writeJson(response, 404, { error: "Sentence submission not found." });
      return;
    }

    const body = await readJsonBody(request);
    const tokens = tokenizeSentence(submission.sentence);
    const ratings = normalizeRatings(body.ratings, tokens.length);
    const vibeConfidencePercent = normalizeConfidencePercent(body.confidencePercent);
    const analysis = analyzeSentiment(submission.sentence);
    const challengePassed = didPassChallenge(
      submission.challengeId,
      analysis.score,
      analysis.tokens,
    );
    const saved = await store.saveScaleResult({
      submissionId,
      participantId: session.participant.id,
      challengePassed,
      vibeConfidencePercent,
      placements: tokens.map((token, tokenIndex) => ({
        tokenIndex,
        tokenText: token.text,
        rating: ratings[tokenIndex],
      })),
    });

    if (!saved) {
      writeJson(response, 404, { error: "Sentence submission not found." });
      return;
    }

    writeJson(response, 200, {
      initialChallengePassed: saved.initialChallengePassed,
      challengePassed: saved.challengePassed,
      vibeConfidencePercent: saved.vibeConfidencePercent,
      scaleSubmittedAt: saved.scaleSubmittedAt,
    });
  } catch (error) {
    if (error instanceof RequestError) {
      writeJson(response, error.status, { error: error.message });
      return;
    }
    if (error instanceof TypeError || error instanceof RangeError) {
      writeJson(response, 400, { error: error.message });
      return;
    }
    console.error("Failed to save vibe-scale choices:", error);
    writeJson(response, 500, { error: "The vibe-scale choices could not be saved." });
  }
}

async function handleTweakAttemptApi(request, response, store, submissionId) {
  if (request.method !== "POST") {
    writeJson(response, 405, { error: "Method not allowed." }, { Allow: "POST" });
    return;
  }

  try {
    const session = await participantSession(request, store);
    if (!session.participant) {
      const headers = session.shouldClear
        ? { "Set-Cookie": sessionCookie(request, "", { clear: true }) }
        : {};
      writeJson(
        response,
        401,
        { error: "Enter your classroom name before saving a Tweak Lab change." },
        headers,
      );
      return;
    }

    const submission = await store.getById(submissionId);
    if (!submission || submission.participantId !== session.participant.id) {
      writeJson(response, 404, { error: "Sentence submission not found." });
      return;
    }
    if (submission.initialChallengePassed == null) {
      writeJson(response, 409, { error: "Save the vibe-scale choices before using Tweak Lab." });
      return;
    }

    const body = await readJsonBody(request);
    const beforeSentence = normalizeSentence(body.beforeSentence);
    const tokens = tokenizeSentence(beforeSentence);
    const tokenIndex = normalizeTweakTokenIndex(body.tokenIndex, tokens.length);
    const replacementText = normalizeReplacementText(body.replacementText);
    const originalToken = tokens[tokenIndex].text;
    const afterSentence = normalizeSentence(
      tokens
        .map((token, index) => index === tokenIndex ? replacementText : token.text)
        .join(" "),
    );
    const beforeAnalysis = analyzeSentiment(beforeSentence);
    const afterAnalysis = analyzeSentiment(afterSentence);
    const attemptPassed = didPassChallenge(
      submission.challengeId,
      afterAnalysis.score,
      afterAnalysis.tokens,
    );
    const saved = await store.saveTweakAttempt({
      submissionId,
      participantId: session.participant.id,
      beforeSentence,
      afterSentence,
      tokenIndex,
      originalToken,
      replacementText,
      beforeScore: beforeAnalysis.score,
      afterScore: afterAnalysis.score,
      attemptPassed,
    });

    if (!saved) {
      writeJson(response, 409, { error: "Save the vibe-scale choices before using Tweak Lab." });
      return;
    }

    writeJson(response, 201, {
      attemptId: saved.id,
      attemptIndex: saved.attemptIndex,
      tokenIndex: saved.tokenIndex,
      originalToken: saved.originalToken,
      replacementText: saved.replacementText,
      afterSentence: saved.afterSentence,
      beforeScore: saved.beforeScore,
      afterScore: saved.afterScore,
      attemptPassed: saved.attemptPassed,
      challengePassed: saved.overallChallengePassed,
      challengeCompletedAt: saved.challengeCompletedAt,
      createdAt: saved.createdAt,
    });
  } catch (error) {
    if (error instanceof TweakSequenceConflictError) {
      writeJson(response, 409, {
        error: error.message,
        currentSentence: error.currentSentence,
        challengePassed: error.challengePassed,
      });
      return;
    }
    if (error instanceof RequestError) {
      writeJson(response, error.status, { error: error.message });
      return;
    }
    if (error instanceof TypeError || error instanceof RangeError) {
      writeJson(response, 400, { error: error.message });
      return;
    }
    console.error("Failed to save Tweak Lab attempt:", error);
    writeJson(response, 500, { error: "The Tweak Lab change could not be saved." });
  }
}

async function servePublicFile(request, response, pathname, rootDirectory) {
  const relativePath = publicFiles.get(pathname);
  if (!relativePath || !["GET", "HEAD"].includes(request.method)) {
    response.writeHead(404, {
      "Content-Type": "text/plain; charset=utf-8",
      "X-Content-Type-Options": "nosniff",
    });
    response.end("Not found");
    return;
  }

  const filePath = join(rootDirectory, relativePath);
  try {
    const info = await stat(filePath);
    if (!info.isFile()) throw new Error("Not a file");
    response.writeHead(200, {
      "Content-Type": contentTypes[extname(filePath)] ?? "application/octet-stream",
      "Content-Length": info.size,
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    });
    if (request.method === "HEAD") response.end();
    else createReadStream(filePath).pipe(response);
  } catch {
    response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    response.end("Not found");
  }
}

export function createVibeCheckServer({ rootDirectory = defaultRoot, store } = {}) {
  if (
    !store
    || typeof store.createParticipant !== "function"
    || typeof store.getParticipantBySessionHash !== "function"
    || typeof store.revokeParticipantSession !== "function"
    || typeof store.saveSentence !== "function"
    || typeof store.getById !== "function"
    || typeof store.saveScaleResult !== "function"
    || typeof store.saveTweakAttempt !== "function"
    || typeof store.close !== "function"
  ) {
    throw new TypeError(
      "store must provide participant, sentence, and close methods",
    );
  }

  const resolvedRoot = resolve(rootDirectory);

  const server = createServer((request, response) => {
    Promise.resolve().then(async () => {
      let pathname;
      try {
        pathname = new URL(request.url, "http://localhost").pathname;
      } catch {
        throw new RequestError(400, "Invalid request URL.");
      }

      if (pathname === "/api/session") {
        await handleSessionApi(request, response, store);
        return;
      }

      if (pathname === "/api/participants") {
        await handleParticipantApi(request, response, store);
        return;
      }

      const scaleResultMatch = pathname.match(
        /^\/api\/sentences\/([1-9]\d*)\/scale-result$/,
      );
      if (scaleResultMatch) {
        const submissionId = Number(scaleResultMatch[1]);
        if (!Number.isSafeInteger(submissionId)) {
          throw new RequestError(400, "Submission ID must be a positive integer.");
        }
        await handleScaleResultApi(request, response, store, submissionId);
        return;
      }

      const challengeCompletionMatch = pathname.match(
        /^\/api\/sentences\/([1-9]\d*)\/challenge-completion$/,
      );
      if (challengeCompletionMatch) {
        writeJson(response, 410, {
          error: "This endpoint has been retired. Save each Tweak Lab change instead.",
        });
        return;
      }

      const tweakAttemptMatch = pathname.match(
        /^\/api\/sentences\/([1-9]\d*)\/tweak-attempts$/,
      );
      if (tweakAttemptMatch) {
        const submissionId = Number(tweakAttemptMatch[1]);
        if (!Number.isSafeInteger(submissionId)) {
          throw new RequestError(400, "Submission ID must be a positive integer.");
        }
        await handleTweakAttemptApi(request, response, store, submissionId);
        return;
      }

      if (pathname === "/api/sentences") {
        await handleSentenceApi(request, response, store);
        return;
      }

      if (pathname.startsWith("/api/")) {
        writeJson(response, 404, { error: "API route not found." });
        return;
      }

      await servePublicFile(request, response, pathname, resolvedRoot);
    }).catch((error) => {
      if (response.headersSent) {
        response.end();
        return;
      }
      if (error instanceof RequestError) {
        writeJson(response, error.status, { error: error.message });
        return;
      }
      console.error("Unhandled request error:", error);
      writeJson(response, 500, { error: "Internal server error." });
    });
  });

  let resourceClosePromise;
  const closeResources = () => {
    if (!resourceClosePromise) {
      resourceClosePromise = Promise.resolve().then(() => store.close());
    }
    return resourceClosePromise;
  };

  server.once("close", () => {
    void closeResources().catch((error) => {
      console.error("Failed to close PostgreSQL connections:", error);
    });
  });

  return { server, store, closeResources };
}

if (process.argv[1] && resolve(process.argv[1]) === modulePath) {
  const port = Number(process.env.PORT) || DEFAULT_PORT;
  let store;

  try {
    store = await createSentenceStore({
      connectionString: databaseUrlFromEnvironment(),
    });
    const { server, closeResources } = createVibeCheckServer({ store });

    await listen(server, port);
    console.log(`VibeCheck is running at http://localhost:${port}`);
    server.on("error", (error) => {
      console.error("Web server error:", error);
      process.exitCode = 1;
    });

    let shuttingDown = false;
    const shutDown = () => {
      if (shuttingDown) return;
      shuttingDown = true;
      server.close(async (error) => {
        try {
          await closeResources();
        } catch (closeError) {
          console.error("Failed to close PostgreSQL connections:", closeError);
          process.exitCode = 1;
        }
        if (error) {
          console.error("Failed to stop the web server:", error);
          process.exitCode = 1;
        }
      });
    };

    process.once("SIGINT", shutDown);
    process.once("SIGTERM", shutDown);
  } catch (error) {
    await store?.close().catch(() => {});
    console.error("VibeCheck could not start:", error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
