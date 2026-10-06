import { createHash, randomBytes } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { extname, join, resolve } from "node:path";
import {
  createSentenceStore,
  databaseUrlFromEnvironment,
  normalizeDisplayName,
} from "./storage.mjs";

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
]);

const contentTypes = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
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
