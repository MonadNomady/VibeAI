# VibeCheck

An interactive, browser-based sentiment analysis lesson based on the storyboard in `VibeCheck-Planning.pdf`.

## Run it

```bash
npm install
DATABASE_URL='postgresql://user:password@host:port/database' npm start
```

Then open <http://localhost:4173>. Node.js 22.13 or newer and a PostgreSQL database are required.

## Stored submissions

When a student presses **Analyze message**, the validated sentence and selected challenge are sent to the server and saved in PostgreSQL. The database also records an ID and UTC submission time. The `sentence_submissions` table is created automatically when the server starts.

`DATABASE_URL` must contain a complete PostgreSQL connection URI. When the app runs on Clever Cloud itself, `POSTGRESQL_ADDON_URI` is also accepted as a fallback. Never commit either value; both contain database credentials.

The former local SQLite database is no longer used, and existing SQLite rows are not copied automatically.

## Deploy with Render and Clever Cloud

1. Create a [PostgreSQL **DEV** add-on](https://www.clever.cloud/developers/deploy/addon/postgresql/postgresql/) in Clever Cloud.
2. In the add-on's information or environment-variable view, copy the complete `POSTGRESQL_ADDON_URI` value.
3. Create a Render Web Service for this repository. Use `npm ci --omit=dev` as the build command and `npm start` as the start command.
4. In [Render's Environment settings](https://render.com/docs/configure-environment-variables), create a secret named `DATABASE_URL` and paste the Clever Cloud URI as its value. Preserve the URI exactly, including any query parameters.
5. Deploy the service. Startup will verify the connection and create the table before the server begins accepting requests.

Because Render and Clever Cloud are separate providers, confirm transport encryption before collecting data. The server reports the connection's TLS status in its startup log. Clever Cloud does not currently document a PostgreSQL TLS setting for this connection. If Clever confirms that the DEV endpoint supports certificate-verified TLS, add `sslmode=verify-full` to the URI. Do not disable certificate verification. You can also check the active connection with `SELECT ssl FROM pg_stat_ssl WHERE pid = pg_backend_pid();`.

The Clever Cloud DEV plan uses shared resources and, [since October 2025](https://www.clever.cloud/developers/changelog/2025/09-01-backups-dev-db/), has no backups or SLA. Use it for this classroom prototype, avoid names or other private student information, and do not treat it as the only copy of important data.

## Test it

```bash
npm test
```

The tests use an in-memory PostgreSQL emulator, so `npm test` does not read or modify the configured Clever Cloud database.

The sentiment engine is intentionally transparent and deterministic so students can inspect how every word affects the result. It deliberately does not detect sarcasm: the sarcasm challenge demonstrates how a literal sentiment model can miss a writer's intended meaning. It is a classroom prototype, not a production language model.
