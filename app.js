import { analyzeSentiment, tokenizeSentence } from "./sentiment.js";
import {
  EMOTION_LABELS,
  buildRadarGeometry,
  classifyEmotions,
  getDominantEmotion,
} from "./emotion-model.js";

const app = document.querySelector("#app");
const toast = document.querySelector("#toast");
const brand = document.querySelector(".brand");

const EMOTION_COLORS = {
  anger: "#e65c54",
  disgust: "#6c9a48",
  fear: "#8b6db1",
  joy: "#e3b333",
  neutral: "#829099",
  sadness: "#568cc3",
  surprise: "#d579b0",
};

const challenges = [
  {
    id: "sarcasm",
    difficulty: "Intermediate challenge",
    prompt: "Write a sarcastic message whose positive words hide a negative feeling.",
    helper: "Can the model notice that the literal words and the real vibe disagree?",
    examples: [
      "Oh wow, thanks SO much for making me wait an hour :/",
      "Sure, I totally love doing homework all weekend.",
      "What a wonderful surprise—another pop quiz.",
      "Perfect, my laptop crashed right before the deadline.",
    ],
  },
  {
    id: "clear-vibe",
    difficulty: "Warm-up challenge",
    prompt: "Write a message with one clear emotional vibe: positive or negative.",
    helper: "Use descriptive words that make the feeling easy to spot.",
    examples: [
      "That concert was absolutely amazing!",
      "I am frustrated that our plans fell apart.",
      "Today has been calm, sunny, and lovely.",
      "This broken app is making me miserable.",
    ],
  },
  {
    id: "mixed",
    difficulty: "Advanced challenge",
    prompt: "Mix positive and negative clues together in the same sentence.",
    helper: "Try using “but” to show a change in feeling.",
    examples: [
      "I loved the movie, but the ending was disappointing.",
      "The trip was exhausting, yet I am so glad we went.",
      "I am nervous about tomorrow but excited to begin.",
      "The food looked awful, although it tasted fantastic.",
    ],
  },
];

const initialEmotionResult = () => ({
  status: "idle",
  sentence: "",
  scores: null,
  error: "",
  progress: null,
});

const initialState = () => ({
  screen: "input",
  challengeIndex: 0,
  sentence: "",
  savedSubmissionKey: null,
  tokens: [],
  userRatings: {},
  userConfidence: 70,
  analysis: null,
  emotionResult: initialEmotionResult(),
});

let state = initialState();
let participantSession = {
  status: "checking",
  participant: null,
  draftName: "",
  message: "",
};
let toastTimer;
let emotionRunId = 0;
let emotionAbortController = null;

const escapeHtml = (value = "") =>
  String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");

const clamp = (value, minimum, maximum) => Math.min(maximum, Math.max(minimum, value));
const titleCase = (value = "") => value.charAt(0).toUpperCase() + value.slice(1);
const signOf = (value) => (value > 0.08 ? 1 : value < -0.08 ? -1 : 0);

function showToast(message) {
  window.clearTimeout(toastTimer);
  toast.textContent = message;
  toast.classList.add("is-visible");
  toastTimer = window.setTimeout(() => toast.classList.remove("is-visible"), 2300);
}

function cancelEmotionAnalysis() {
  emotionRunId += 1;
  emotionAbortController?.abort();
  emotionAbortController = null;
}

function resetEmotionAnalysis() {
  cancelEmotionAnalysis();
  state.emotionResult = initialEmotionResult();
}

async function apiError(response, fallbackMessage) {
  let message = fallbackMessage;
  try {
    const body = await response.json();
    if (body?.error) message = body.error;
  } catch {
    // Keep the safe fallback when the server did not return JSON.
  }
  const error = new Error(message);
  error.status = response.status;
  return error;
}

async function loadParticipantSession() {
  try {
    const response = await fetch("/api/session", {
      headers: { Accept: "application/json" },
    });
    if (!response.ok) throw await apiError(response, "The classroom session could not be checked.");
    const body = await response.json();
    if (body?.participant?.displayName) {
      participantSession = {
        status: "ready",
        participant: body.participant,
        draftName: "",
        message: "",
      };
    } else {
      participantSession = {
        status: "required",
        participant: null,
        draftName: "",
        message: "",
      };
    }
  } catch {
    participantSession = {
      status: "required",
      participant: null,
      draftName: "",
      message: "We couldn’t check this browser’s classroom name. Enter it below to try again.",
    };
  }
  render();
  focusScreenHeading();
}

async function createParticipant(displayName) {
  const response = await fetch("/api/participants", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ displayName }),
  });
  if (!response.ok) throw await apiError(response, "The classroom name could not be saved.");
  return response.json();
}

async function saveSentenceInput(sentence, challengeId) {
  const response = await fetch("/api/sentences", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sentence, challengeId }),
  });

  if (!response.ok) {
    throw await apiError(response, "The sentence could not be saved.");
  }

  return response.json();
}

function updateProgress() {
  const order = ["input", "scale", "results"];
  const currentIndex = order.indexOf(state.screen);
  const progressNav = document.querySelector(".site-header nav");

  if (participantSession.status !== "ready") {
    progressNav.hidden = true;
    progressNav.removeAttribute("data-current-step");
    progressNav.setAttribute("aria-label", "Activity steps begin after choosing a classroom name");
    return;
  }

  progressNav.hidden = false;
  progressNav.dataset.currentStep = String(currentIndex + 1);
  progressNav.setAttribute("aria-label", `Activity progress, step ${currentIndex + 1} of ${order.length}`);

  document.querySelectorAll(".progress-step").forEach((step, index) => {
    step.classList.toggle("is-active", index === currentIndex);
    step.classList.toggle("is-complete", index < currentIndex);
    if (index === currentIndex) step.setAttribute("aria-current", "step");
    else step.removeAttribute("aria-current");
  });
}

function focusScreenHeading() {
  window.scrollTo({ top: 0, behavior: "smooth" });
  window.requestAnimationFrame(() => app.querySelector("h1")?.focus({ preventScroll: true }));
}

function navigate(screen) {
  state.screen = screen;
  render();
  focusScreenHeading();
}

function render() {
  updateProgress();
  if (participantSession.status !== "ready") {
    renderParticipantGate();
    return;
  }
  if (state.screen === "scale") renderScale();
  else if (state.screen === "results") renderResults();
  else renderInput();
}

function participantIdentityMarkup() {
  const name = participantSession.participant?.displayName ?? "";
  return `
    <div class="participant-strip" aria-label="Current classroom name">
      <span>Working as <strong>${escapeHtml(name)}</strong></span>
      <button class="switch-participant" type="button" data-switch-participant>Not ${escapeHtml(name)}? Switch user</button>
    </div>`;
}

function renderParticipantGate() {
  const isChecking = participantSession.status === "checking";
  const isSaving = participantSession.status === "saving";
  const draftName = participantSession.draftName;
  document.title = "VibeCheck — Choose a classroom name";

  app.innerHTML = `
    <section class="screen participant-screen" aria-labelledby="participant-title">
      <div class="participant-welcome">
        <p class="eyebrow">Before we start</p>
        <h1 id="participant-title" tabindex="-1">What should we call you?</h1>
        <p>This is a classroom label, not an account or login.</p>
      </div>

      <div class="paper-card participant-card">
        ${isChecking
          ? `
            <div class="participant-checking" role="status" aria-live="polite">
              <span class="model-spinner" aria-hidden="true"></span>
              <div><strong>Checking this browser…</strong><p>Looking for a classroom name you already chose.</p></div>
            </div>`
          : `
            <form id="participant-form" novalidate ${isSaving ? `aria-busy="true"` : ""}>
              <label class="field-label" for="participant-name">First name, nickname, or class code</label>
              <input
                class="name-input"
                id="participant-name"
                name="displayName"
                type="text"
                value="${escapeHtml(draftName)}"
                autocomplete="off"
                aria-describedby="participant-help participant-storage participant-error"
                ${isSaving ? "disabled" : ""}
                required
              />
              <p class="participant-help" id="participant-help">Use 40 characters or fewer for your first name, a nickname, or the class code your teacher gave you. Don’t enter your full name or other private information.</p>
              <p class="participant-storage" id="participant-storage">We’ll save this classroom name with the sentences you submit so your teacher can tell whose experiment it was.</p>
              <p class="field-error" id="participant-error" role="alert">${escapeHtml(participantSession.message)}</p>
              <button class="gradient-button full-width" id="participant-submit" type="submit" ${draftName.trim() && !isSaving ? "" : "disabled"}>
                ${isSaving ? "Saving your name…" : "Start the activity"}
              </button>
            </form>`}
      </div>
    </section>`;

  if (isChecking || isSaving) return;

  const form = app.querySelector("#participant-form");
  const input = app.querySelector("#participant-name");
  const submit = app.querySelector("#participant-submit");
  const error = app.querySelector("#participant-error");

  input.addEventListener("input", () => {
    participantSession.draftName = input.value;
    participantSession.message = "";
    error.textContent = "";
    submit.disabled = !input.value.trim();
  });

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const displayName = input.value.normalize("NFC").trim().replace(/\s+/gu, " ");
    if (!displayName) {
      error.textContent = "Enter a first name, nickname, or class code.";
      input.focus();
      return;
    }
    if ([...displayName].length > 40) {
      error.textContent = "Keep your classroom name to 40 characters or fewer.";
      input.focus();
      return;
    }

    participantSession.status = "saving";
    participantSession.draftName = displayName;
    participantSession.message = "";
    renderParticipantGate();

    try {
      const body = await createParticipant(displayName);
      participantSession = {
        status: "ready",
        participant: body.participant,
        draftName: "",
        message: "",
      };
      state = initialState();
      render();
      focusScreenHeading();
      showToast(`Welcome, ${body.participant.displayName}!`);
    } catch (saveError) {
      participantSession.status = "required";
      participantSession.message = saveError.message;
      renderParticipantGate();
      window.requestAnimationFrame(() => app.querySelector("#participant-name")?.focus());
    }
  });
}

async function switchParticipant(button) {
  const hasWork = Boolean(state.sentence.trim()) || state.screen !== "input";
  if (
    hasWork
    && !window.confirm(
      "Switch users and clear the work currently on this page? Sentences already submitted will stay saved.",
    )
  ) {
    return;
  }

  button.disabled = true;
  const originalLabel = button.textContent;
  button.textContent = "Switching…";

  try {
    const response = await fetch("/api/session", { method: "DELETE" });
    if (!response.ok) throw await apiError(response, "The classroom user could not be switched.");

    const challengeIndex = state.challengeIndex;
    cancelEmotionAnalysis();
    state = initialState();
    state.challengeIndex = challengeIndex;
    participantSession = {
      status: "required",
      participant: null,
      draftName: "",
      message: "Enter the classroom name for the next user.",
    };
    render();
    focusScreenHeading();
  } catch {
    button.disabled = false;
    button.textContent = originalLabel;
    showToast("We couldn’t switch users. Check the server and try again.");
  }
}

function renderInput() {
  const challenge = challenges[state.challengeIndex];
  const isReady = state.sentence.trim().length > 0;
  document.title = "VibeCheck — Input challenge";
  app.innerHTML = `
    <section class="screen" aria-labelledby="input-title">
      ${participantIdentityMarkup()}
      <div class="hero">
        <p class="eyebrow">Sentiment lab</p>
        <h1 id="input-title" tabindex="-1">How does AI read human emotion?</h1>
        <p>Write a message, predict the vibe of each word, then peek inside a sentiment model’s reasoning.</p>
      </div>

      <div class="challenge-wrap" aria-label="Choose a challenge">
        <button class="round-button" id="previous-challenge" type="button" aria-label="Previous challenge">←</button>
        <article class="paper-card challenge-card">
          <span class="difficulty">${escapeHtml(challenge.difficulty)}</span>
          <span class="challenge-label">Active challenge</span>
          <p class="challenge-prompt">${escapeHtml(challenge.prompt)}</p>
        </article>
        <button class="round-button" id="next-challenge" type="button" aria-label="Next challenge">→</button>
      </div>

      <div class="challenge-dots" role="group" aria-label="Challenge choices">
        ${challenges
          .map(
            (_, index) => `
              <button
                class="challenge-dot ${index === state.challengeIndex ? "is-active" : ""}"
                type="button"
                data-challenge-index="${index}"
                aria-label="Show challenge ${index + 1}"
                aria-pressed="${index === state.challengeIndex}"
              ></button>`,
          )
          .join("")}
      </div>

      <form id="message-form" novalidate>
        <div class="paper-card input-card">
          <label class="field-label" for="sentence-input">Type your experiment here</label>
          <div class="textarea-shell">
            <textarea
              id="sentence-input"
              name="sentence"
              maxlength="240"
              placeholder="Try a sentence with a strong or surprising vibe…"
              aria-describedby="challenge-helper storage-note input-error"
              required
            >${escapeHtml(state.sentence)}</textarea>
            <span class="character-count"><span id="character-count">${state.sentence.length}</span>/240</span>
          </div>
          <p class="storage-note" id="storage-note">This sentence will be saved with the classroom name <strong>${escapeHtml(participantSession.participant.displayName)}</strong>. Don’t include anyone’s full name, address, username, or other private information.</p>
          <p class="field-error" id="input-error" aria-live="polite"></p>
          <p id="challenge-helper" class="starter-label">${escapeHtml(challenge.helper)}</p>
          <ul class="starter-list" aria-label="Sentence starters">
            ${challenge.examples
              .map(
                (example) => `
                  <li><button class="starter-chip" type="button" data-example="${escapeHtml(example)}">${escapeHtml(example)}</button></li>`,
              )
              .join("")}
          </ul>
        </div>
        <button class="gradient-button full-width" id="analyze-button" type="submit" ${isReady ? "" : "disabled"}>
          Analyze message
        </button>
      </form>
    </section>
  `;

  const textarea = app.querySelector("#sentence-input");
  const count = app.querySelector("#character-count");
  const submit = app.querySelector("#analyze-button");
  const error = app.querySelector("#input-error");

  app.querySelector("#previous-challenge").addEventListener("click", () => {
    state.challengeIndex = (state.challengeIndex - 1 + challenges.length) % challenges.length;
    renderInput();
  });

  app.querySelector("#next-challenge").addEventListener("click", () => {
    state.challengeIndex = (state.challengeIndex + 1) % challenges.length;
    renderInput();
  });

  app.querySelectorAll("[data-challenge-index]").forEach((button) => {
    button.addEventListener("click", () => {
      state.challengeIndex = Number(button.dataset.challengeIndex);
      renderInput();
    });
  });

  textarea.addEventListener("input", () => {
    state.sentence = textarea.value;
    count.textContent = textarea.value.length;
    submit.disabled = !textarea.value.trim();
    error.textContent = "";
  });

  app.querySelectorAll("[data-example]").forEach((button) => {
    button.addEventListener("click", () => {
      state.sentence = button.dataset.example;
      textarea.value = state.sentence;
      count.textContent = state.sentence.length;
      submit.disabled = false;
      error.textContent = "";
      textarea.focus();
      textarea.setSelectionRange(state.sentence.length, state.sentence.length);
    });
  });

  const form = app.querySelector("#message-form");

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const sentence = textarea.value.trim();
    const tokens = tokenizeSentence(sentence).map((token, index) => ({
      ...token,
      id: token.id ?? `token-${index}`,
    }));

    if (!sentence) {
      error.textContent = "Write a sentence before moving on.";
      textarea.focus();
      return;
    }

    if (!tokens.length) {
      error.textContent = "Add at least one word or emoji for the model to inspect.";
      textarea.focus();
      return;
    }

    const challengeId = challenge.id;
    const submissionKey = `${participantSession.participant.id}\u0000${challengeId}\u0000${sentence}`;

    if (state.savedSubmissionKey !== submissionKey) {
      const controls = [...app.querySelectorAll("button, textarea")];
      form.setAttribute("aria-busy", "true");
      controls.forEach((control) => { control.disabled = true; });
      submit.textContent = "Saving message…";
      error.textContent = "";

      try {
        await saveSentenceInput(sentence, challengeId);
        state.savedSubmissionKey = submissionKey;
      } catch (saveError) {
        if (saveError.status === 401) {
          const challengeIndex = state.challengeIndex;
          cancelEmotionAnalysis();
          state = initialState();
          state.challengeIndex = challengeIndex;
          participantSession = {
            status: "required",
            participant: null,
            draftName: "",
            message: "Your classroom session ended. Enter your classroom name again.",
          };
          render();
          focusScreenHeading();
          return;
        }
        form.removeAttribute("aria-busy");
        controls.forEach((control) => { control.disabled = false; });
        submit.textContent = "Analyze message";
        submit.disabled = !sentence;
        error.textContent = "We couldn’t save this sentence. Check that the app server is running, then try again.";
        textarea.focus();
        return;
      }
    }

    state.sentence = sentence;
    state.tokens = tokens;
    state.userRatings = Object.fromEntries(tokens.map((token) => [token.id, 0]));
    state.analysis = null;
    resetEmotionAnalysis();
    navigate("scale");
    showToast("Message saved to the class database.");
  });
}

function ratingMeta(rating) {
  if (rating < 0) return { name: "Negative", direction: "−", next: 0 };
  if (rating > 0) return { name: "Positive", direction: "+", next: -1 };
  return { name: "Neutral", direction: "↻", next: 1 };
}

function scaleStatus() {
  const ratings = Object.values(state.userRatings);
  const negative = ratings.filter((rating) => rating < 0).length;
  const positive = ratings.filter((rating) => rating > 0).length;
  const difference = positive - negative;
  return {
    negative,
    positive,
    neutral: ratings.length - negative - positive,
    difference,
    tilt: clamp(difference * 1.8, -7, 7),
    label: difference > 0 ? "Leaning positive" : difference < 0 ? "Leaning negative" : "Balanced / neutral",
  };
}

function tokenMarkup(token) {
  const rating = Number(state.userRatings[token.id] ?? 0);
  const meta = ratingMeta(rating);
  const punctuationClass = token.isWord === false ? "is-punctuation" : "";
  return `
    <button
      class="token-chip ${punctuationClass}"
      type="button"
      draggable="true"
      data-token-id="${escapeHtml(token.id)}"
      data-rating="${rating}"
      aria-label="${escapeHtml(token.text)}, currently ${meta.name}. Click to change it to ${ratingMeta(meta.next).name}; use left and right arrow keys for the scale."
      title="Drag me, click to cycle, or use ← and →"
    >
      <span>${escapeHtml(token.text)}</span>
      <span class="token-direction" aria-hidden="true">${meta.direction}</span>
    </button>
  `;
}

function zoneMarkup(rating, name, hint) {
  const tokens = state.tokens.filter((token) => Number(state.userRatings[token.id] ?? 0) === rating);
  return `
    <section class="drop-zone" data-rating="${rating}" aria-label="${name} words drop area">
      <h2 class="zone-heading">
        <span>${escapeHtml(name)} <small>— ${escapeHtml(hint)}</small></span>
        <span class="zone-count" aria-label="${tokens.length} tokens">${tokens.length}</span>
      </h2>
      <div class="token-cloud">
        ${tokens.length ? tokens.map(tokenMarkup).join("") : `<p class="empty-zone">Drop words here</p>`}
      </div>
    </section>
  `;
}

function renderScale(options = {}) {
  const status = scaleStatus();
  document.title = "VibeCheck — Your turn";
  app.innerHTML = `
    <section class="screen" aria-labelledby="scale-title">
      ${participantIdentityMarkup()}
      <button class="back-button" id="back-to-input" type="button">← Edit my sentence</button>

      <div class="stage-heading">
        <p class="eyebrow">Your turn</p>
        <h1 id="scale-title" tabindex="-1">The vibe scale</h1>
        <p>Sort each token by the feeling it carries. Drag it, click to cycle, or use the arrow keys. Unsure? Leave it neutral.</p>
      </div>

      <div class="sentence-ribbon">
        <strong>Your message</strong>
        ${escapeHtml(state.sentence)}
      </div>

      <div class="paper-card scale-card">
        <div class="scale-visual" style="--tilt: ${status.tilt}deg" aria-hidden="true"><span class="scale-face"></span></div>
        <div class="sentiment-bins">
          ${zoneMarkup(-1, "Negative", "pulls the vibe down")}
          ${zoneMarkup(1, "Positive", "lifts the vibe up")}
          ${zoneMarkup(0, "Neutral tray", "no strong feeling or unsure")}
        </div>
        <div class="scale-help">
          <span>Tip: punctuation and emojis can carry a vibe too.</span>
          <span class="scale-tilt">Scale tilt: ${escapeHtml(status.label)}</span>
        </div>
      </div>

      <div class="paper-card confidence-card">
        <div>
          <div class="confidence-head">
            <h2>Your call</h2>
            <output class="confidence-value" id="confidence-output" for="confidence-slider">${state.userConfidence}%</output>
          </div>
          <p class="confidence-help">How sure are you about your word choices?</p>
          <input id="confidence-slider" type="range" min="0" max="100" step="1" value="${state.userConfidence}" />
          <div class="range-ends" aria-hidden="true"><span>Just guessing</span><span>Very sure</span></div>
        </div>
        <div class="mapping-box">
          <span class="tiny-label">Your sentiment map</span>
          <div class="mapping-preview">
            ${state.tokens
              .map(
                (token) => `<span class="mini-token" data-rating="${state.userRatings[token.id] ?? 0}">${escapeHtml(token.text)}</span>`,
              )
              .join("")}
          </div>
        </div>
      </div>

      <button class="gradient-button full-width" id="reveal-results" type="button">Lock in and reveal results</button>
    </section>
  `;

  app.querySelector("#back-to-input").addEventListener("click", () => navigate("input"));

  app.querySelector("#confidence-slider").addEventListener("input", (event) => {
    state.userConfidence = Number(event.target.value);
    app.querySelector("#confidence-output").textContent = `${state.userConfidence}%`;
  });

  app.querySelectorAll(".drop-zone").forEach((zone) => {
    zone.addEventListener("dragover", (event) => {
      event.preventDefault();
      event.dataTransfer.dropEffect = "move";
      zone.classList.add("is-dragover");
    });
    zone.addEventListener("dragleave", () => zone.classList.remove("is-dragover"));
    zone.addEventListener("drop", (event) => {
      event.preventDefault();
      zone.classList.remove("is-dragover");
      const tokenId = event.dataTransfer.getData("text/plain");
      if (tokenId in state.userRatings) updateTokenRating(tokenId, Number(zone.dataset.rating));
    });
  });

  app.querySelectorAll(".token-chip").forEach((chip) => {
    chip.addEventListener("dragstart", (event) => {
      event.dataTransfer.effectAllowed = "move";
      event.dataTransfer.setData("text/plain", chip.dataset.tokenId);
    });

    chip.addEventListener("click", () => {
      const current = Number(state.userRatings[chip.dataset.tokenId] ?? 0);
      updateTokenRating(chip.dataset.tokenId, ratingMeta(current).next);
    });

    chip.addEventListener("keydown", (event) => {
      if (!["ArrowLeft", "ArrowRight", "Home"].includes(event.key)) return;
      event.preventDefault();
      const current = Number(state.userRatings[chip.dataset.tokenId] ?? 0);
      const next = event.key === "Home" ? 0 : clamp(current + (event.key === "ArrowLeft" ? -1 : 1), -1, 1);
      updateTokenRating(chip.dataset.tokenId, next);
    });
  });

  app.querySelector("#reveal-results").addEventListener("click", () => {
    state.analysis = analyzeSentiment(state.sentence);
    navigate("results");
  });

  if (options.focusTokenId) {
    window.requestAnimationFrame(() => {
      const target = [...app.querySelectorAll(".token-chip")].find(
        (chip) => chip.dataset.tokenId === options.focusTokenId,
      );
      target?.focus({ preventScroll: true });
    });
  }
}

function updateTokenRating(tokenId, rating) {
  state.userRatings[tokenId] = clamp(Number(rating), -1, 1);
  renderScale({ focusTokenId: tokenId });
}

function normalizedConfidence(value) {
  const confidence = Number(value ?? 0);
  return Math.round(confidence <= 1 ? confidence * 100 : confidence);
}

function tokenWeight(token) {
  return clamp(Number(token.weight ?? token.score ?? 0), -1, 1);
}

function userCall() {
  const ratings = Object.values(state.userRatings).map(Number);
  const sum = ratings.reduce((total, rating) => total + rating, 0);
  const positive = ratings.filter((rating) => rating > 0).length;
  const negative = ratings.filter((rating) => rating < 0).length;
  if (positive && negative && Math.abs(sum) <= 1) return "Mixed";
  if (sum > 0) return "Positive";
  if (sum < 0) return "Negative";
  return "Neutral";
}

function agreementScore(analysisTokens) {
  const comparableTokens = analysisTokens
    .map((token, index) => ({ token, index }))
    .filter(({ token, index }) => {
      const inputToken = state.tokens[index];
      const userRating = Number(state.userRatings[inputToken?.id] ?? 0);
      const modelRating = signOf(tokenWeight(token));
      return userRating !== 0 || modelRating !== 0;
    });
  if (!comparableTokens.length) return 100;
  const matches = comparableTokens.filter(({ token, index }) => {
    const inputToken = state.tokens[index];
    const userRating = Number(state.userRatings[inputToken?.id] ?? 0);
    return signOf(tokenWeight(token)) === userRating;
  }).length;
  return Math.round((matches / comparableTokens.length) * 100);
}

function formatSigned(value, digits = 2) {
  const rounded = Number(value).toFixed(digits);
  return value > 0 ? `+${rounded}` : rounded;
}

function challengeFeedback(label, score) {
  const challenge = challenges[state.challengeIndex];
  const normalizedLabel = label.toLowerCase();
  if (challenge.id === "sarcasm") {
    return "This model only follows visible word and emoji weights. It cannot know whether you meant the message sarcastically.";
  }
  if (challenge.id === "mixed") {
    if (normalizedLabel.includes("mixed") || Math.abs(score) < 0.18) return "The model noticed competing emotional clues—challenge complete.";
    return `The ${score > 0 ? "positive" : "negative"} clues dominated this sentence, so its mixed vibe was less visible.`;
  }
  const expected = score > 0.08 ? "positive" : score < -0.08 ? "negative" : "neutral";
  return `The model found a clear ${expected} signal in your message.`;
}

function fallbackEmotions(score) {
  const positive = Math.max(0, score);
  const negative = Math.max(0, -score);
  return {
    positive: clamp(positive, 0, 1),
    negative: clamp(negative, 0, 1),
    neutral: clamp(1 - Math.abs(score), 0, 1),
  };
}

function emotionEntries(scores = {}) {
  return EMOTION_LABELS.map((label) => ({
    label,
    score: clamp(Number(scores[label] ?? 0), 0, 1),
  }));
}

function emotionRadarMarkup(scores) {
  const geometry = buildRadarGeometry(scores, {
    width: 340,
    height: 300,
    centerX: 170,
    centerY: 145,
    radius: 96,
    labelOffset: 24,
  });

  return `
    <svg class="emotion-radar" viewBox="${geometry.viewBox}" aria-hidden="true" focusable="false">
      ${geometry.rings.map((ring) => `<polygon class="radar-grid" points="${ring.points}"></polygon>`).join("")}
      ${geometry.axes
        .map(
          (axis) => `
            <line class="radar-axis" x1="${geometry.centerX}" y1="${geometry.centerY}" x2="${axis.x}" y2="${axis.y}"></line>
            <text class="radar-label" x="${axis.labelX}" y="${axis.labelY}" dy="0.35em">${escapeHtml(titleCase(axis.label))}</text>`,
        )
        .join("")}
      <polygon class="radar-score" points="${geometry.polygon}"></polygon>
      ${geometry.points
        .map(
          (point) => `<circle class="radar-dot" cx="${point.x}" cy="${point.y}" r="4" style="--emotion-color: ${EMOTION_COLORS[point.label]}"></circle>`,
        )
        .join("")}
    </svg>`;
}

function emotionLoadingMarkup(progress = null) {
  const hasProgress = Number.isFinite(progress);
  const normalizedProgress = hasProgress ? clamp(Math.round(progress), 0, 100) : null;
  return `
    <div class="model-loading" aria-busy="true">
      <div class="model-loading-head">
        <span class="model-spinner" aria-hidden="true"></span>
        <div>
          <strong>Loading the neural emotion model…</strong>
          <p id="emotion-model-status" role="status" aria-live="polite" aria-atomic="true" tabindex="-1">The word-weight result above is ready while this optional model loads.</p>
        </div>
      </div>
      <div class="model-progress-row">
        <progress id="emotion-model-progress" max="100" ${hasProgress ? `value="${normalizedProgress}"` : ""} aria-label="Emotion model download progress">${hasProgress ? normalizedProgress : 0}%</progress>
        <span class="model-progress-value" id="emotion-model-progress-value">${hasProgress ? `${normalizedProgress}%` : "…"}</span>
      </div>
      <p class="model-download-note">First use downloads about 83 MB of model weights. Your browser normally caches them for later visits.</p>
    </div>`;
}

function emotionReadyMarkup(scores) {
  const entries = emotionEntries(scores);
  const dominant = getDominantEmotion(scores);
  const dominantLabel = dominant?.label ?? null;
  const dominantScore = clamp(Number(dominant?.score ?? 0), 0, 1);

  return `
    <div class="emotion-model-callout" id="emotion-model-status" role="status" aria-live="polite" aria-atomic="true" tabindex="-1">
      <span>Neural model’s strongest label</span>
      <strong>${dominantLabel ? `${escapeHtml(titleCase(dominantLabel))} · ${Math.round(dominantScore * 100)}%` : "No clear label"}</strong>
    </div>
    <div class="emotion-model-layout">
      <div>${emotionRadarMarkup(scores)}</div>
      <div class="emotion-model-bars" role="list" aria-label="Neural emotion model scores">
        ${entries
          .map(({ label, score }) => {
            const percent = Math.round(score * 100);
            const color = EMOTION_COLORS[label];
            return `
              <div class="emotion-score-row" role="listitem" style="--bar-color: ${color}">
                <span class="emotion-score-label"><span class="emotion-score-dot" style="--emotion-color: ${color}" aria-hidden="true"></span>${escapeHtml(titleCase(label))}</span>
                <progress max="100" value="${(score * 100).toFixed(2)}" aria-label="${escapeHtml(titleCase(label))} model score, ${percent} percent">${percent}%</progress>
                <span class="emotion-score-value" aria-hidden="true">${percent}%</span>
              </div>`;
          })
          .join("")}
      </div>
    </div>
    <p class="emotion-model-caution"><strong>Important:</strong> These are the model’s relative scores for seven possible labels—not measurements of what you actually feel. The model can misunderstand context and sarcasm.</p>
    <p class="emotion-model-credit">Model: <a href="https://huggingface.co/j-hartmann/emotion-english-distilroberta-base" target="_blank" rel="noreferrer">Jochen Hartmann’s Emotion English DistilRoBERTa-base</a>, run in this browser using an <a href="https://huggingface.co/onnx-community/emotion-english-distilroberta-base-ONNX" target="_blank" rel="noreferrer">ONNX Community conversion</a>. The fine-tuned model card does not declare a license.</p>`;
}

function emotionErrorMarkup() {
  return `
    <div class="model-error">
      <div id="emotion-model-status" role="status" aria-live="polite" aria-atomic="true" tabindex="-1">
        <strong>The optional emotion model couldn’t load.</strong>
        <p>Your word-weight result is still complete. A school filter, connection problem, or browser setting may have blocked the model files.</p>
      </div>
      <button class="model-retry-button" id="retry-emotion-model" type="button">Try loading it again</button>
    </div>`;
}

function emotionModelContentMarkup() {
  if (state.emotionResult.status === "ready" && state.emotionResult.scores) {
    return emotionReadyMarkup(state.emotionResult.scores);
  }
  if (state.emotionResult.status === "error") return emotionErrorMarkup();
  return emotionLoadingMarkup(state.emotionResult.progress);
}

function bindEmotionPanelActions() {
  app.querySelector("#retry-emotion-model")?.addEventListener("click", () => {
    void startEmotionAnalysis({ force: true });
  });
}

function updateEmotionPanel() {
  const content = app.querySelector("#emotion-model-content");
  if (!content) return;
  content.innerHTML = emotionModelContentMarkup();
  bindEmotionPanelActions();
}

function updateEmotionProgress(progress) {
  const progressElement = app.querySelector("#emotion-model-progress");
  const valueElement = app.querySelector("#emotion-model-progress-value");
  if (!progressElement || !valueElement) return;
  progressElement.value = progress;
  progressElement.textContent = `${progress}%`;
  valueElement.textContent = `${progress}%`;
  if (progress >= 100) {
    const heading = app.querySelector(".model-loading-head strong");
    const status = app.querySelector("#emotion-model-status");
    if (heading) heading.textContent = "Model loaded—reading the sentence…";
    if (status) status.textContent = "The model is loaded and is now reading the sentence.";
  }
}

async function startEmotionAnalysis({ force = false } = {}) {
  const sentence = state.sentence.trim();
  if (!sentence) return;

  const current = state.emotionResult;
  const isSameSentence = current.sentence === sentence;
  if (!force && isSameSentence && current.status !== "idle") return;

  emotionAbortController?.abort();
  const controller = new AbortController();
  emotionAbortController = controller;
  const runId = ++emotionRunId;

  state.emotionResult = {
    status: "loading",
    sentence,
    scores: null,
    error: "",
    progress: null,
  };
  updateEmotionPanel();
  if (force) app.querySelector("#emotion-model-status")?.focus({ preventScroll: true });

  try {
    const scores = await classifyEmotions(sentence, {
      signal: controller.signal,
      onProgress(update) {
        if (runId !== emotionRunId || state.sentence.trim() !== sentence) return;
        const numericProgress = Number(update?.progress ?? update);
        if (!Number.isFinite(numericProgress)) return;
        const progress = clamp(Math.round(numericProgress), 0, 100);
        if (progress === state.emotionResult.progress) return;
        state.emotionResult.progress = progress;
        updateEmotionProgress(progress);
      },
    });

    if (runId !== emotionRunId || state.sentence.trim() !== sentence) return;
    state.emotionResult = {
      status: "ready",
      sentence,
      scores,
      error: "",
      progress: 100,
    };
    updateEmotionPanel();
    if (force) app.querySelector("#emotion-model-status")?.focus({ preventScroll: true });
  } catch (error) {
    if (controller.signal.aborted || runId !== emotionRunId || state.sentence.trim() !== sentence) return;
    console.warn("Optional emotion model failed:", error);
    state.emotionResult = {
      status: "error",
      sentence,
      scores: null,
      error: "The optional emotion model could not load.",
      progress: null,
    };
    updateEmotionPanel();
    if (force) app.querySelector("#emotion-model-status")?.focus({ preventScroll: true });
  } finally {
    if (emotionAbortController === controller) emotionAbortController = null;
  }
}

function renderResults() {
  const analysis = state.analysis ?? analyzeSentiment(state.sentence);
  state.analysis = analysis;
  const tokens = Array.isArray(analysis.tokens) ? analysis.tokens : [];
  const score = clamp(Number(analysis.score ?? 0), -1, 1);
  const label = titleCase(analysis.label || (score > 0.08 ? "positive" : score < -0.08 ? "negative" : "neutral"));
  const confidence = normalizedConfidence(analysis.confidence);
  const agreement = agreementScore(tokens);
  const call = userCall();
  const emotions = analysis.emotions && Object.keys(analysis.emotions).length
    ? analysis.emotions
    : fallbackEmotions(score);
  const emotionColors = ["#e4b73c", "#f05e58", "#6b9fd3", "#9a7bc4", "#61c976", "#e781a0", "#d3794a"];
  const nonZeroTokens = tokens.filter((token) => Math.abs(tokenWeight(token)) > 0.005);
  const summary = analysis.summary || `The model combined ${nonZeroTokens.length} emotional clue${nonZeroTokens.length === 1 ? "" : "s"} to place this message on the sentiment scale.`;
  document.title = "VibeCheck — AI results";

  app.innerHTML = `
    <section class="screen" aria-labelledby="results-title">
      ${participantIdentityMarkup()}
      <button class="back-button" id="back-to-scale" type="button">← Revisit my word map</button>

      <div class="stage-heading">
        <p class="eyebrow">Inside the model</p>
        <h1 id="results-title" tabindex="-1">Here’s how the AI read it</h1>
        <p>Compare your instinct with an explainable word-weight model and a neural emotion classifier.</p>
      </div>

      <div class="sentence-ribbon result-quote">
        <strong>Analyzing input message</strong>
        ${escapeHtml(state.sentence)}
      </div>

      <div class="result-grid">
        <article class="paper-card classification-card">
          <div class="classification-top">
            <div>
              <span class="tiny-label">Word-weight sentiment classification</span>
              <h2 class="classification-name">${escapeHtml(label)}</h2>
              <p class="classification-summary">${escapeHtml(summary)}</p>
            </div>
            <span class="confidence-badge">${confidence}% word-model confidence</span>
          </div>
          <div class="sentiment-gauge" aria-label="Sentiment score ${formatSigned(score)} on a scale from negative one to positive one">
            <div class="gauge-track">
              <span class="gauge-marker" style="--score-position: ${clamp((score + 1) * 50, 1, 99)}%"><span>${formatSigned(score, 1)}</span></span>
            </div>
            <div class="gauge-labels" aria-hidden="true"><span>−1.0 Negative</span><span>0 Neutral</span><span>+1.0 Positive</span></div>
          </div>
          <div class="model-note"><strong>Challenge check:</strong> ${escapeHtml(challengeFeedback(label, score))}</div>
        </article>

        <aside class="paper-card comparison-card">
          <span class="tiny-label">You vs. the word model</span>
          <h2>${agreement}% word agreement</h2>
          <p>How often your word labels matched the model’s direction.</p>
          <div class="comparison-score" style="--agreement: ${agreement}%"><strong>${agreement}%</strong></div>
          <div class="call-row"><span>Your call</span><span class="call-pill">${escapeHtml(call)}</span></div>
          <div class="call-row"><span>Your confidence</span><span class="call-pill">${state.userConfidence}%</span></div>
          <div class="call-row"><span>Word model’s call</span><span class="call-pill">${escapeHtml(label)}</span></div>
        </aside>
      </div>

      <article class="paper-card weights-card section-card">
        <span class="tiny-label"><span class="section-number">1</span>Transparent model pipeline</span>
        <h2>Individual token weights</h2>
        <p class="weights-intro">Each token starts with a dictionary score. Context—like negation, emphasis, or contrast—can change its final weight.</p>
        <details class="weights-details" ${window.matchMedia("(min-width: 561px)").matches ? "open" : ""}>
          <summary><span>Token-by-token explanations</span><span>${tokens.length} tokens</span></summary>
          <div class="weights-list" role="list" aria-label="Individual token sentiment weights">
            ${tokens
              .map((token) => {
                const weight = tokenWeight(token);
                const direction = weight > 0.005 ? "is-positive" : weight < -0.005 ? "is-negative" : "";
                const reason = token.reason || (direction ? "Sentiment clue" : "No strong sentiment signal");
                return `
                  <div class="weight-row" role="listitem">
                    <span class="weight-word" title="${escapeHtml(token.text)}">${escapeHtml(token.text)}</span>
                    <span class="weight-bar" aria-hidden="true"><span class="weight-fill ${direction}" style="--amount: ${Math.abs(weight) * 50}%"></span></span>
                    <span class="weight-value ${direction}">${formatSigned(weight)}</span>
                    <span class="weight-reason">${escapeHtml(reason)}</span>
                  </div>`;
              })
              .join("")}
          </div>
        </details>
        <div class="calculation-box">
          <span class="tiny-label">Aggregate score calculation</span>
          <div class="formula-list">
            ${(nonZeroTokens.length ? nonZeroTokens : tokens.slice(0, 1))
              .map((token, index, visibleTokens) => {
                const weight = tokenWeight(token);
                const direction = weight > 0.005 ? "is-positive" : weight < -0.005 ? "is-negative" : "";
                return `<span class="formula-term${index === visibleTokens.length - 1 ? " is-last" : ""}"><span>${escapeHtml(token.text)}</span> <strong class="${direction}">${formatSigned(weight)}</strong></span>`;
              })
              .join("")}
            <span class="formula-total">${nonZeroTokens.length > 1 ? `÷ √${nonZeroTokens.length} = ` : "= "}Final ${formatSigned(score)}</span>
          </div>
        </div>
      </article>

      <article class="paper-card emotion-card section-card">
        <span class="tiny-label"><span class="section-number">2</span>Signal map</span>
        <h2>Sentiment signal mix</h2>
        <p>This shows how much positive, negative, and neutral evidence the prototype found—not facts about the writer.</p>
        <div class="emotion-grid">
          ${Object.entries(emotions)
            .map(([emotion, rawValue], index) => {
              const value = clamp(Number(rawValue), 0, 1);
              return `
                <div class="emotion-row">
                  <span>${escapeHtml(titleCase(emotion))}</span>
                  <span class="emotion-track" aria-hidden="true"><span class="emotion-fill" style="--value: ${Math.round(value * 100)}%; --emotion-color: ${emotionColors[index % emotionColors.length]}"></span></span>
                  <span>${Math.round(value * 100)}%</span>
                </div>`;
            })
            .join("")}
        </div>
      </article>

      <article class="paper-card emotion-model-card section-card" id="emotion-model-card" aria-labelledby="emotion-model-title">
        <div class="emotion-model-heading">
          <div>
            <span class="tiny-label"><span class="section-number">3</span>Neural model comparison</span>
            <h2 id="emotion-model-title">Seven-emotion guess</h2>
            <p class="emotion-model-intro">A separate DistilRoBERTa model reads the whole sentence and compares seven emotion labels. Unlike the word model, it does not expose a weight for each word.</p>
          </div>
          <span class="model-kind">Optional browser model</span>
        </div>
        <div class="emotion-model-content" id="emotion-model-content">
          ${emotionModelContentMarkup()}
        </div>
      </article>

      <div class="results-actions">
        <button class="text-button" id="adjust-map" type="button">Adjust my word map</button>
        <button class="gradient-button" id="start-over" type="button">Try another message</button>
      </div>
    </section>
  `;

  app.querySelector("#back-to-scale").addEventListener("click", () => navigate("scale"));
  app.querySelector("#adjust-map").addEventListener("click", () => navigate("scale"));
  app.querySelector("#start-over").addEventListener("click", () => {
    const challengeIndex = state.challengeIndex;
    cancelEmotionAnalysis();
    state = initialState();
    state.challengeIndex = challengeIndex;
    render();
    focusScreenHeading();
    showToast("Fresh page, fresh vibe.");
  });

  bindEmotionPanelActions();
  void startEmotionAnalysis();
}

app.addEventListener("click", (event) => {
  const switchButton = event.target instanceof Element
    ? event.target.closest("[data-switch-participant]")
    : null;
  if (switchButton) void switchParticipant(switchButton);
});

brand.addEventListener("click", (event) => {
  event.preventDefault();
  if (participantSession.status !== "ready") {
    window.scrollTo({ top: 0, behavior: "smooth" });
    return;
  }
  if (state.screen === "input") {
    window.scrollTo({ top: 0, behavior: "smooth" });
    return;
  }
  navigate("input");
});

render();
void loadParticipantSession();
