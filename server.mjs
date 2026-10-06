import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { extname, join, resolve } from "node:path";
import { createSentenceStore, databaseUrlFromEnvironment } from "./storage.mjs";

const DEFAULT_PORT = 4173;
const MAX_BODY_BYTES = 4_096;
const modulePath = fileURLToPath(import.meta.url);
const defaultRoot = fileURLToPath(new URL(".", import.meta.url));

const publicFiles = new Map([
  ["/", "index.html"],
  ["/index.html", "index.html"],
  ["/app.js", "app.js"],
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

async function handleSentenceApi(request, response, store) {
  if (request.method !== "POST") {
    writeJson(response, 405, { error: "Method not allowed." }, { Allow: "POST" });
    return;
  }

  try {
    const body = await readJsonBody(request);
    const saved = await store.saveSentence({
      sentence: body.sentence,
      challengeId: body.challengeId,
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
  if (!store || typeof store.saveSentence !== "function" || typeof store.close !== "function") {
    throw new TypeError("store must provide saveSentence() and close() methods");
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
