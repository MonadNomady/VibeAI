# VibeCheck

An interactive, browser-based sentiment analysis lesson based on the storyboard in `VibeCheck-Planning.pdf`.

## Run it

```bash
npm start
```

Then open <http://localhost:4173>. Node.js 22.13 or newer is required. The server has no third-party runtime dependencies.

## Stored submissions

When a student presses **Analyze message**, the validated sentence and selected challenge are saved in `data/vibecheck.sqlite` on the app server. Inputs are not sent to an external service. The database also records an ID and UTC submission time.

To store the database elsewhere, set `VIBECHECK_DB_PATH` before starting the server. To clear all submissions, stop the server and remove the SQLite database plus its `-wal` and `-shm` companion files.

## Test it

```bash
npm test
```

The sentiment engine is intentionally transparent and deterministic so students can inspect how every word affects the result. It deliberately does not detect sarcasm: the sarcasm challenge demonstrates how a literal sentiment model can miss a writer's intended meaning. It is a classroom prototype, not a production language model.

## Optional emotion model

The results page also compares the transparent sentiment engine with Jochen Hartmann's `emotion-english-distilroberta-base` model. It scores seven possible labels: anger, disgust, fear, joy, neutral, sadness, and surprise. The chart shows model scores, not a measurement of what a student actually feels, and the model can misunderstand context or sarcasm.

Emotion analysis runs locally in the student's browser through Transformers.js and an ONNX Community conversion of the model. The submitted sentence is not sent to an emotion-analysis API. On first use, the browser downloads about 83 MB of quantized model weights from Hugging Face plus the Transformers.js library from jsDelivr; browsers normally cache those files for later visits. A school content filter, private browsing, or cache eviction can prevent or repeat that download. If it fails, the original word-weight result remains available.

Model credit: [Jochen Hartmann, “Emotion English DistilRoBERTa-base” (2022)](https://huggingface.co/j-hartmann/emotion-english-distilroberta-base), converted for browser use by [ONNX Community](https://huggingface.co/onnx-community/emotion-english-distilroberta-base-ONNX), and run with [Transformers.js](https://huggingface.co/docs/transformers.js/). The fine-tuned model card does not currently declare a license, so confirm usage rights before a public production deployment.
