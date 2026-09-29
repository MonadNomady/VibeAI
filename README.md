# VibeCheck

An interactive, browser-based sentiment analysis lesson based on the storyboard in `VibeCheck-Planning.pdf`.

## Run it

```bash
npm start
```

Then open <http://localhost:4173>. Node.js 22.13 or newer is required. The app has no third-party runtime dependencies.

## Stored submissions

When a student presses **Analyze message**, the validated sentence and selected challenge are saved in `data/vibecheck.sqlite` on the app server. Inputs are not sent to an external service. The database also records an ID and UTC submission time.

To store the database elsewhere, set `VIBECHECK_DB_PATH` before starting the server. To clear all submissions, stop the server and remove the SQLite database plus its `-wal` and `-shm` companion files.

## Test it

```bash
npm test
```

The sentiment engine is intentionally transparent and deterministic so students can inspect how every word affects the result. It is a classroom prototype, not a production language model.
