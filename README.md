# VibeCheck

An interactive, browser-based sentiment analysis lesson based on the storyboard in `VibeCheck-Planning.pdf`.

## Run it

```bash
npm install
DATABASE_URL='postgresql://user:password@host:port/database' npm start
```

Then open <http://localhost:4173>. Node.js 22.13 or newer and a PostgreSQL database are required.

## Stored submissions

On a first visit, the app asks for a first name, nickname, or teacher-provided class code. PostgreSQL stores that classroom label in `participants`. Each row in `sentence_submissions` has a required `participant_id` foreign key, so submitted sentences can be joined back to the participant who entered them.

The browser receives a 30-day, HttpOnly `vibecheck_session` cookie. The database stores only its SHA-256 hash, not the raw session token, and the sentence API derives the participant from that cookie instead of trusting a participant ID from the page. **Switch user** expires that server-side session and clears the browser cookie, while deliberately keeping earlier participant and submission records.

The schema and migration run automatically at startup. Submissions that existed before participant tracking are preserved and linked to the reserved participant **Before names were collected**. The former local SQLite database is no longer used, and existing SQLite rows are not copied automatically.

For a classroom, prefer nicknames or class codes over full legal names, and do not collect email addresses, student IDs, addresses, or other unnecessary personal information.

`DATABASE_URL` must contain a complete PostgreSQL connection URI. When the app runs on Clever Cloud itself, `POSTGRESQL_ADDON_URI` is also accepted as a fallback. Never commit either value; both contain database credentials.

## Deploy with Render and Clever Cloud

1. Create a [PostgreSQL **DEV** add-on](https://www.clever.cloud/developers/deploy/addon/postgresql/postgresql/) in Clever Cloud.
2. In the add-on's information or environment-variable view, copy the complete `POSTGRESQL_ADDON_URI` value.
3. Create a Render Web Service for this repository. Use `npm ci --omit=dev` as the build command and `npm start` as the start command.
4. In [Render's Environment settings](https://render.com/docs/configure-environment-variables), create a secret named `DATABASE_URL` and paste the Clever Cloud URI as its value. Preserve the URI exactly, including any query parameters.
5. Deploy the service. Startup will verify the connection and create the table before the server begins accepting requests.

Because Render and Clever Cloud are separate providers, confirm transport encryption before collecting data. The server reports the connection's TLS status in its startup log. Clever Cloud does not currently document a PostgreSQL TLS setting for this connection. If Clever confirms that the DEV endpoint supports certificate-verified TLS, add `sslmode=verify-full` to the URI. Do not disable certificate verification. You can also check the active connection with `SELECT ssl FROM pg_stat_ssl WHERE pid = pg_backend_pid();`.

The Clever Cloud DEV plan uses shared resources and has no SLA. Clever Cloud currently documents one free backup per day with seven days of retention; confirm those backups in the add-on dashboard and keep your own export for anything important. See the [Clever Cloud PostgreSQL documentation](https://www.clever-cloud.com/developers/doc/addons/postgresql/).

## Test it

```bash
npm test
```

The tests use an in-memory PostgreSQL emulator, so `npm test` does not read or modify the configured Clever Cloud database.

The sentiment engine is intentionally transparent and deterministic so students can inspect how every word affects the result. It deliberately does not detect sarcasm: the sarcasm challenge demonstrates how a literal sentiment model can miss a writer's intended meaning. It is a classroom prototype, not a production language model.

## Optional emotion model

The results page also compares the transparent sentiment engine with Jochen Hartmann's `emotion-english-distilroberta-base` model. It scores seven possible labels: anger, disgust, fear, joy, neutral, sadness, and surprise. The chart shows model scores, not a measurement of what a student actually feels, and the model can misunderstand context or sarcasm.

Emotion analysis runs locally in the student's browser through Transformers.js and an ONNX Community conversion of the model. The submitted sentence is not sent to an emotion-analysis API. On first use, the browser downloads about 83 MB of quantized model weights from Hugging Face plus the Transformers.js library from jsDelivr; browsers normally cache those files for later visits. A school content filter, private browsing, or cache eviction can prevent or repeat that download. If it fails, the original word-weight result remains available.

Model credit: [Jochen Hartmann, “Emotion English DistilRoBERTa-base” (2022)](https://huggingface.co/j-hartmann/emotion-english-distilroberta-base), converted for browser use by [ONNX Community](https://huggingface.co/onnx-community/emotion-english-distilroberta-base-ONNX), and run with [Transformers.js](https://huggingface.co/docs/transformers.js/). The fine-tuned model card does not currently declare a license, so confirm usage rights before a public production deployment.
