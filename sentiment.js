/**
 * A small, dependency-free sentiment engine for VibeCheck.
 *
 * The goal here is explainability rather than linguistic perfection: every
 * visible token is preserved and every score can be traced back to a word,
 * emoji, or a nearby modifier.
 */

const WORD_SENTIMENT = Object.freeze({
  // Positive words
  amazing: 0.92,
  amazed: 0.76,
  appreciate: 0.68,
  appreciated: 0.7,
  appreciating: 0.68,
  awesome: 0.92,
  beautiful: 0.82,
  best: 0.9,
  better: 0.58,
  brilliant: 0.88,
  calm: 0.42,
  celebrate: 0.72,
  celebrated: 0.7,
  charming: 0.68,
  cheerful: 0.74,
  clean: 0.4,
  comfortable: 0.5,
  confident: 0.62,
  cool: 0.48,
  delightful: 0.84,
  easy: 0.42,
  enjoy: 0.68,
  enjoyed: 0.68,
  enjoying: 0.68,
  excellent: 0.9,
  excited: 0.8,
  exciting: 0.76,
  fantastic: 0.94,
  favorite: 0.78,
  fine: 0.24,
  friendly: 0.58,
  fun: 0.7,
  funny: 0.62,
  glad: 0.68,
  good: 0.68,
  gorgeous: 0.86,
  grateful: 0.76,
  great: 0.82,
  happiest: 0.9,
  happy: 0.78,
  helpful: 0.58,
  hope: 0.48,
  hopeful: 0.66,
  incredible: 0.9,
  inspiring: 0.78,
  joy: 0.82,
  joyful: 0.86,
  kind: 0.56,
  laugh: 0.64,
  laughed: 0.64,
  laughing: 0.64,
  like: 0.46,
  liked: 0.46,
  love: 0.9,
  loved: 0.86,
  lovely: 0.8,
  loving: 0.82,
  lucky: 0.62,
  nice: 0.58,
  outstanding: 0.9,
  peaceful: 0.64,
  perfect: 0.9,
  pleased: 0.68,
  proud: 0.7,
  recommend: 0.62,
  recommended: 0.62,
  relief: 0.58,
  relieved: 0.62,
  safe: 0.5,
  smile: 0.6,
  smiling: 0.6,
  spectacular: 0.94,
  slaps: 0.74,
  success: 0.72,
  successful: 0.74,
  sweet: 0.56,
  terrific: 0.9,
  thankful: 0.72,
  thank: 0.58,
  thanks: 0.68,
  thrilled: 0.86,
  win: 0.7,
  winner: 0.72,
  wonderful: 0.9,
  wow: 0.62,
  yay: 0.78,
  yes: 0.32,

  // Negative words
  afraid: -0.72,
  angry: -0.82,
  annoy: -0.58,
  annoyed: -0.66,
  annoying: -0.68,
  anxious: -0.62,
  awful: -0.9,
  bad: -0.7,
  boring: -0.62,
  broken: -0.58,
  confused: -0.4,
  cruel: -0.78,
  cry: -0.68,
  crying: -0.72,
  danger: -0.72,
  dangerous: -0.78,
  disappointed: -0.74,
  disappointing: -0.76,
  disaster: -0.88,
  disgusting: -0.9,
  dislike: -0.58,
  disliked: -0.58,
  dreadful: -0.88,
  fail: -0.68,
  failed: -0.7,
  failure: -0.74,
  fear: -0.68,
  furious: -0.9,
  gross: -0.72,
  hate: -0.9,
  hated: -0.88,
  horrible: -0.92,
  hurt: -0.62,
  irritating: -0.68,
  lonely: -0.68,
  lose: -0.6,
  loser: -0.66,
  lost: -0.56,
  mean: -0.56,
  miserable: -0.88,
  nasty: -0.72,
  nervous: -0.52,
  pain: -0.68,
  painful: -0.74,
  poor: -0.56,
  problem: -0.42,
  regret: -0.62,
  ridiculous: -0.64,
  rude: -0.68,
  ruin: -0.76,
  ruined: -0.78,
  ruining: -0.78,
  sad: -0.74,
  saddest: -0.88,
  scary: -0.7,
  sick: -0.58,
  sorry: -0.46,
  stress: -0.58,
  stressed: -0.66,
  stressful: -0.68,
  stupid: -0.76,
  sucks: -0.78,
  terrible: -0.92,
  terrified: -0.9,
  tired: -0.46,
  ugly: -0.72,
  unhappy: -0.76,
  unsafe: -0.68,
  upset: -0.68,
  useless: -0.76,
  weak: -0.54,
  worst: -0.94,
  worry: -0.58,
  worried: -0.64,
  wrong: -0.5,
  yuck: -0.76,
});

const EMOJI_SENTIMENT = Object.freeze({
  '😀': 0.82,
  '😃': 0.84,
  '😄': 0.86,
  '😁': 0.78,
  '😊': 0.72,
  '🙂': 0.5,
  '🥰': 0.9,
  '😍': 0.9,
  '🤩': 0.88,
  '😘': 0.74,
  '😇': 0.62,
  '😂': 0.72,
  '🤣': 0.76,
  '😅': 0.3,
  '😉': 0.4,
  '😎': 0.58,
  '🥳': 0.86,
  '🤗': 0.68,
  '❤': 0.9,
  '💕': 0.84,
  '💖': 0.88,
  '💗': 0.82,
  '💚': 0.78,
  '💙': 0.78,
  '💜': 0.78,
  '👍': 0.68,
  '👏': 0.7,
  '🙌': 0.76,
  '🎉': 0.78,
  '✨': 0.5,
  '🔥': 0.62,
  ':)': 0.62,
  ':-)': 0.62,
  ':d': 0.72,
  ';d': 0.68,
  ';)': 0.5,
  ';-)': 0.5,
  '<3': 0.86,

  '🙁': -0.56,
  '☹': -0.68,
  '😞': -0.72,
  '😔': -0.68,
  '😢': -0.78,
  '😭': -0.88,
  '😡': -0.86,
  '😠': -0.8,
  '🤬': -0.94,
  '😤': -0.62,
  '😨': -0.78,
  '😰': -0.74,
  '😱': -0.82,
  '🤢': -0.7,
  '🤮': -0.88,
  '😬': -0.42,
  '😒': -0.58,
  '🙄': -0.52,
  '😑': -0.36,
  '💔': -0.9,
  '👎': -0.7,
  '💩': -0.62,
  ':(': -0.68,
  ':-(': -0.68,
  ':/': -0.36,
  ':-/': -0.36,
  '>:(': -0.8,
});

const NEGATORS = new Set([
  'aint', "ain't", 'cannot', "can't", 'didnt', "didn't", 'doesnt', "doesn't",
  'dont', "don't", 'hardly', 'isnt', "isn't", 'neither', 'never', 'no', 'nobody',
  'none', 'nor', 'not', 'nothing', 'nowhere', 'scarcely', 'wasnt', "wasn't",
  'werent', "weren't", 'without', 'wont', "won't", 'wouldnt', "wouldn't",
]);

const INTENSIFIERS = new Map([
  ['absolutely', 1.5],
  ['completely', 1.4],
  ['deeply', 1.3],
  ['especially', 1.2],
  ['extremely', 1.6],
  ['genuinely', 1.15],
  ['highly', 1.25],
  ['incredibly', 1.5],
  ['particularly', 1.2],
  ['really', 1.3],
  ['so', 1.2],
  ['super', 1.4],
  ['too', 1.15],
  ['totally', 1.35],
  ['truly', 1.25],
  ['very', 1.35],
]);

const DOWNTONERS = new Map([
  ['almost', 0.8],
  ['barely', 0.45],
  ['fairly', 0.82],
  ['hardly', 0.5],
  ['kinda', 0.7],
  ['kind', 0.74],
  ['little', 0.72],
  ['mostly', 0.86],
  ['partly', 0.76],
  ['slightly', 0.55],
  ['somewhat', 0.7],
  ['sorta', 0.7],
  ['sort', 0.74],
]);

const CONTRAST_WORDS = new Set(['although', 'but', 'however', 'though', 'yet', 'nevertheless']);
const SARCASM_EMOJIS = new Set(['🙄', '😒']);
const GRATITUDE_WORDS = new Set(['thank', 'thanks']);
const SARCASM_SITUATION_WORDS = new Set([
  'broke', 'broken', 'breaking', 'delayed', 'forgot', 'forgetting', 'forgotten',
  'ignored', 'ignoring', 'late', 'mess', 'nothing', 'problem', 'ruin', 'ruined',
  'ruining', 'terrible', 'wait', 'waiting', 'worst',
]);
const CLAUSE_BOUNDARY = /^(?:[.!?]+|[;:])$/u;
const WORD_TEST = /[\p{L}\p{M}\p{N}]/u;
const EMOJI_TEST = /(?:\p{Extended_Pictographic}|\p{Regional_Indicator}|[#*0-9]\uFE0F?\u20E3)/u;
const EMOTICON_TEST = /^(?:<3|>:?[-'^~]?[(/\\]|[:;=8xX][-'^~]?[)(/\\DPpOo])$/u;

// The order matters: emoticons and complete emoji sequences are captured
// before their individual punctuation characters.
const TOKEN_PATTERN = /(?:<3|>:?[-'^~]?[(/\\]|[:;=8xX][-'^~]?[)(\/\\DPpOo])|(?:\p{Regional_Indicator}{2})|(?:[#*0-9]\uFE0F?\u20E3)|(?:\p{Extended_Pictographic}(?:\uFE0F|\p{Emoji_Modifier})?(?:\u200D\p{Extended_Pictographic}(?:\uFE0F|\p{Emoji_Modifier})?)*)|(?:[#@][\p{L}\p{M}\p{N}_]+)|(?:[\p{L}\p{M}\p{N}]+(?:[’'][\p{L}\p{M}\p{N}]+)*)|(?:[!?]+|\.{2,}|[^\s])/gu;

const clamp = (value, min = -1, max = 1) => Math.min(max, Math.max(min, value));
const round = (value, places = 3) => {
  const factor = 10 ** places;
  return Math.round((value + Number.EPSILON) * factor) / factor;
};

function normalizeText(text) {
  const normalized = text.normalize('NFKC').toLocaleLowerCase('en-US').replaceAll('’', "'");
  return normalized.startsWith('#') ? normalized.slice(1) : normalized;
}

function emojiLookupKey(text) {
  return normalizeText(text).replaceAll('\uFE0F', '').replace(/\p{Emoji_Modifier}/gu, '');
}

function baseWeightFor(token) {
  if (Object.hasOwn(WORD_SENTIMENT, token.normalized)) {
    return WORD_SENTIMENT[token.normalized];
  }

  const emojiKey = emojiLookupKey(token.text);
  return Object.hasOwn(EMOJI_SENTIMENT, emojiKey) ? EMOJI_SENTIMENT[emojiKey] : 0;
}

function strengthDescription(weight) {
  const magnitude = Math.abs(weight);
  if (magnitude >= 0.85) return 'very strongly';
  if (magnitude >= 0.65) return 'strongly';
  if (magnitude >= 0.4) return 'moderately';
  return 'mildly';
}

function labelFor(weight) {
  if (weight > 0.05) return 'positive';
  if (weight < -0.05) return 'negative';
  return 'neutral';
}

/**
 * Split a sentence into display-safe tokens.
 *
 * Whitespace is not returned, but punctuation, contractions, emoticons, and
 * multi-code-point emoji remain intact. `start` and `end` can be used to place
 * tokens back into the exact original sentence.
 */
export function tokenizeSentence(sentence = '') {
  const source = String(sentence ?? '');
  const matches = source.matchAll(TOKEN_PATTERN);

  return Array.from(matches, (match, index) => {
    const text = match[0];
    const start = match.index ?? 0;
    const isEmoji = EMOJI_TEST.test(text) || EMOTICON_TEST.test(text);
    const isWord = !isEmoji && WORD_TEST.test(text);

    return {
      id: `token-${index}`,
      index,
      text,
      normalized: normalizeText(text),
      isWord,
      isEmoji,
      isPunctuation: !isWord && !isEmoji,
      start,
      end: start + text.length,
    };
  });
}

function findModifiers(tokens, sentimentIndex, rawWeights) {
  let multiplier = 1;
  let isNegated = false;
  let examinedWords = 0;
  const modifiers = [];

  for (let index = sentimentIndex - 1; index >= 0 && examinedWords < 4; index -= 1) {
    const candidate = tokens[index];
    if (CLAUSE_BOUNDARY.test(candidate.text) || CONTRAST_WORDS.has(candidate.normalized)) break;
    if (!candidate.isWord) continue;

    examinedWords += 1;
    // A previous sentiment cue normally ends the useful modifier window. This
    // prevents "not good and fun" from incorrectly negating both adjectives.
    if (rawWeights[index] !== 0) break;

    if (NEGATORS.has(candidate.normalized)) {
      isNegated = !isNegated;
      modifiers.push({ index, type: 'negation', text: candidate.text, factor: -0.9 });
      continue;
    }

    if (INTENSIFIERS.has(candidate.normalized)) {
      const factor = INTENSIFIERS.get(candidate.normalized);
      multiplier *= factor;
      modifiers.push({ index, type: 'intensifier', text: candidate.text, factor });
      continue;
    }

    if (DOWNTONERS.has(candidate.normalized)) {
      const factor = DOWNTONERS.get(candidate.normalized);
      multiplier *= factor;
      modifiers.push({ index, type: 'downtoner', text: candidate.text, factor });
    }
  }

  if (isNegated) multiplier *= -0.9;
  return { multiplier, isNegated, modifiers: modifiers.reverse() };
}

function describeBaseToken(token, rawWeight) {
  const direction = rawWeight > 0 ? 'positive' : 'negative';
  const kind = token.isEmoji ? 'expression' : 'word';
  return `“${token.text}” is a ${strengthDescription(rawWeight)} ${direction} ${kind}.`;
}

function emptyAnalyzedToken(token) {
  return {
    ...token,
    rawWeight: 0,
    weight: 0,
    score: 0,
    sentiment: 0,
    label: 'neutral',
    role: token.isPunctuation ? 'punctuation' : 'context',
    reason: token.isPunctuation ? 'Punctuation with no direct sentiment weight.' : 'No direct sentiment signal detected.',
    appliedModifiers: [],
    sarcasmCue: false,
  };
}

function applyPunctuationEmphasis(analyzedTokens) {
  for (let index = 0; index < analyzedTokens.length; index += 1) {
    const punctuation = analyzedTokens[index];
    if (!punctuation.isPunctuation || !/^[!?]+$/u.test(punctuation.text)) continue;

    let targetIndex = index - 1;
    while (targetIndex >= 0) {
      const candidate = analyzedTokens[targetIndex];
      if (CLAUSE_BOUNDARY.test(candidate.text)) break;
      if (candidate.weight !== 0) break;
      targetIndex -= 1;
    }

    if (targetIndex < 0 || analyzedTokens[targetIndex].weight === 0) continue;

    const exclamations = (punctuation.text.match(/!/g) ?? []).length;
    const questions = (punctuation.text.match(/\?/g) ?? []).length;
    const emphasisMultiplier = 1 + Math.min(0.24, exclamations * 0.08);
    const uncertaintyMultiplier = questions > 0 ? 0.94 : 1;
    const multiplier = emphasisMultiplier * uncertaintyMultiplier;
    const target = analyzedTokens[targetIndex];

    target.weight = round(clamp(target.weight * multiplier));
    target.score = target.weight;
    target.sentiment = target.weight;
    target.label = labelFor(target.weight);
    target.appliedModifiers.push({
      token: punctuation.text,
      type: questions > 0 && exclamations === 0 ? 'uncertainty' : 'punctuation-emphasis',
      factor: round(multiplier),
    });
    target.reason += exclamations > 0
      ? ` ${punctuation.text} adds emphasis.`
      : ' A question mark slightly softens the certainty.';

    punctuation.role = 'emphasis';
    punctuation.reason = exclamations > 0
      ? `Adds emphasis to “${target.text}”; its effect is included in that token's weight.`
      : `Slightly softens “${target.text}”; its effect is included in that token's weight.`;
  }
}

function emotionBreakdown(tokens, positiveMass, negativeMass) {
  const meaningfulTokens = tokens.filter((token) => token.isWord || token.isEmoji).length;
  const scoredTokens = tokens.filter((token) => token.weight !== 0).length;
  const neutralMass = scoredTokens === 0
    ? Math.max(1, meaningfulTokens)
    : Math.max(0.12, (meaningfulTokens - scoredTokens) * 0.12);
  const total = positiveMass + negativeMass + neutralMass;

  if (total === 0) return { positive: 0, negative: 0, neutral: 1 };

  const positive = round(positiveMass / total);
  const negative = round(negativeMass / total);
  return {
    positive,
    negative,
    neutral: round(Math.max(0, 1 - positive - negative)),
  };
}

function buildSummary(label, tokens, positiveMass, negativeMass) {
  const cues = tokens.filter((token) => token.weight !== 0);
  if (cues.length === 0) return 'No strong positive or negative cues were detected.';

  const strongest = cues.reduce((best, token) => (
    Math.abs(token.weight) > Math.abs(best.weight) ? token : best
  ));

  if (label === 'neutral') {
    return positiveMass > 0 && negativeMass > 0
      ? 'Positive and negative cues are closely balanced, so the sentence reads as mixed or neutral.'
      : 'The detected language is too mild to lean clearly positive or negative.';
  }

  const opposite = label === 'positive' ? negativeMass : positiveMass;
  const nuance = opposite > 0 ? ', despite some mixed language' : '';
  return `The sentence reads as ${label}${nuance}; the strongest cue is “${strongest.text}” (${strongest.weight > 0 ? '+' : ''}${strongest.weight.toFixed(2)}).`;
}

function noSarcasmDetected() {
  return {
    detected: false,
    type: null,
    confidence: 0,
    reason: 'No clear contradiction or sarcasm phrase was detected.',
    cueIndices: [],
  };
}

function detectSarcasm(tokens) {
  const wordIndices = tokens
    .map((token, index) => (token.isWord ? index : -1))
    .filter((index) => index >= 0);

  // "Yeah right" is treated as sarcasm only when it is a short utterance,
  // is followed by punctuation, or comments on an explicit sentiment cue.
  // This avoids flagging a direction such as "yeah, right there".
  for (let position = 0; position < wordIndices.length - 1; position += 1) {
    const yeahIndex = wordIndices[position];
    const rightIndex = wordIndices[position + 1];
    if (tokens[yeahIndex].normalized !== 'yeah' || tokens[rightIndex].normalized !== 'right') continue;

    const followingToken = tokens[rightIndex + 1];
    const hasClosingPunctuation = Boolean(followingToken && /^[,.!?;:]+$/u.test(followingToken.text));
    const hasLaterSentiment = tokens.slice(rightIndex + 1).some((token) => Math.abs(token.weight) > 0.1);
    if (wordIndices.length <= 3 || hasClosingPunctuation || hasLaterSentiment) {
      return {
        detected: true,
        type: 'disbelief-phrase',
        confidence: 0.84,
        reason: '“yeah right” commonly signals disbelief rather than literal agreement',
        cueIndices: [yeahIndex, rightIndex],
      };
    }
  }

  // Gratitude followed by "for" and an explicitly negative outcome is a
  // narrow structural contradiction. Plain gratitude remains positive.
  const gratitudeIndex = tokens.findIndex(
    (token) => GRATITUDE_WORDS.has(token.normalized) && token.weight > 0.1,
  );
  if (gratitudeIndex >= 0) {
    const forIndex = tokens.findIndex(
      (token, index) => index > gratitudeIndex && token.normalized === 'for',
    );
    if (forIndex >= 0) {
      const situationIndex = tokens.findIndex((token, index) => (
        index > forIndex
        && (token.weight < -0.1 || SARCASM_SITUATION_WORDS.has(token.normalized))
      ));
      if (situationIndex >= 0) {
        return {
          detected: true,
          type: 'sarcastic-gratitude',
          confidence: 0.88,
          reason: 'the gratitude phrase points to a clearly negative outcome',
          cueIndices: [gratitudeIndex, forIndex, situationIndex],
        };
      }
    }
  }

  // Eye-roll and unamused emoji can contradict literal praise. Requiring a
  // positively weighted word keeps a lone negative emoji from being labeled
  // sarcastic.
  const positiveIndex = tokens.findIndex((token) => token.isWord && token.weight > 0.12);
  const emojiIndex = tokens.findIndex((token) => SARCASM_EMOJIS.has(emojiLookupKey(token.text)));
  if (positiveIndex >= 0 && emojiIndex >= 0) {
    return {
      detected: true,
      type: 'emoji-contradiction',
      confidence: 0.86,
      reason: `positive wording conflicts with the ${tokens[emojiIndex].text} reaction`,
      cueIndices: [positiveIndex, emojiIndex],
    };
  }

  return noSarcasmDetected();
}

function buildSarcasmSummary(sarcasm, score, literalLabel) {
  const signedScore = `${score > 0 ? '+' : ''}${score.toFixed(2)}`;
  const literalReading = literalLabel === 'neutral' ? 'are neutral' : `lean ${literalLabel}`;
  return `The sentence likely reads as sarcastic because ${sarcasm.reason}. The literal token weights ${literalReading} (${signedScore}).`;
}

/**
 * Analyze a sentence and return an overall result plus explainable token data.
 * All public scores and weights are constrained to the range -1..1.
 */
export function analyzeSentiment(sentence = '') {
  const source = String(sentence ?? '');
  const tokens = tokenizeSentence(source);
  const rawWeights = tokens.map(baseWeightFor);
  const lastContrastIndex = tokens.reduce(
    (latest, token, index) => (CONTRAST_WORDS.has(token.normalized) ? index : latest),
    -1,
  );

  const analyzedTokens = tokens.map((token, index) => {
    const rawWeight = rawWeights[index];
    if (rawWeight === 0) {
      const result = emptyAnalyzedToken(token);

      if (NEGATORS.has(token.normalized)) {
        result.role = 'modifier';
        result.reason = 'Reverses the next nearby sentiment cue.';
      } else if (INTENSIFIERS.has(token.normalized)) {
        result.role = 'modifier';
        result.reason = `Strengthens the next nearby sentiment cue (×${INTENSIFIERS.get(token.normalized)}).`;
      } else if (DOWNTONERS.has(token.normalized)) {
        result.role = 'modifier';
        result.reason = `Softens the next nearby sentiment cue (×${DOWNTONERS.get(token.normalized)}).`;
      } else if (CONTRAST_WORDS.has(token.normalized)) {
        result.role = 'contrast';
        result.reason = 'Introduces a contrast, giving the sentiment after it more influence.';
      }

      return result;
    }

    const { multiplier: contextMultiplier, isNegated, modifiers } = findModifiers(tokens, index, rawWeights);
    let contrastMultiplier = 1;
    if (lastContrastIndex >= 0) {
      contrastMultiplier = index < lastContrastIndex ? 0.65 : index > lastContrastIndex ? 1.25 : 1;
    }

    const lettersOnly = token.text.replace(/[^\p{L}]/gu, '');
    const isAllCaps = token.isWord
      && lettersOnly.length >= 2
      && lettersOnly === lettersOnly.toLocaleUpperCase('en-US')
      && lettersOnly !== lettersOnly.toLocaleLowerCase('en-US');
    const capsMultiplier = isAllCaps ? 1.15 : 1;
    const weight = round(clamp(rawWeight * contextMultiplier * contrastMultiplier * capsMultiplier));
    const appliedModifiers = modifiers.map((modifier) => ({
      token: modifier.text,
      type: modifier.type,
      factor: modifier.factor,
    }));

    if (lastContrastIndex >= 0) {
      appliedModifiers.push({
        token: tokens[lastContrastIndex].text,
        type: index < lastContrastIndex ? 'before-contrast' : 'after-contrast',
        factor: contrastMultiplier,
      });
    }
    if (isAllCaps) appliedModifiers.push({ token: token.text, type: 'all-caps', factor: capsMultiplier });

    let reason = describeBaseToken(token, rawWeight);
    if (isNegated) reason += ' A nearby negation reverses it.';
    const intensifier = modifiers.find((modifier) => modifier.type === 'intensifier');
    const downtoner = modifiers.find((modifier) => modifier.type === 'downtoner');
    if (intensifier) reason += ` “${intensifier.text}” strengthens it.`;
    if (downtoner) reason += ` “${downtoner.text}” softens it.`;
    if (lastContrastIndex >= 0) {
      reason += index < lastContrastIndex
        ? ' It has less influence before the contrast.'
        : ' It has more influence after the contrast.';
    }
    if (isAllCaps) reason += ' Capital letters add emphasis.';

    return {
      ...token,
      rawWeight,
      weight,
      score: weight,
      sentiment: weight,
      label: labelFor(weight),
      role: 'sentiment',
      reason,
      appliedModifiers,
      sarcasmCue: false,
    };
  });

  applyPunctuationEmphasis(analyzedTokens);

  const sentimentTokens = analyzedTokens.filter((token) => token.weight !== 0);
  const totalWeight = sentimentTokens.reduce((sum, token) => sum + token.weight, 0);
  const cueCount = sentimentTokens.length;
  const score = cueCount === 0 ? 0 : round(clamp(totalWeight / Math.sqrt(cueCount)));
  const literalLabel = score > 0.12 ? 'positive' : score < -0.12 ? 'negative' : 'neutral';
  const sarcasm = detectSarcasm(analyzedTokens);
  const label = sarcasm.detected ? 'sarcastic' : literalLabel;

  if (sarcasm.detected) {
    for (const index of sarcasm.cueIndices) {
      analyzedTokens[index].sarcasmCue = true;
      analyzedTokens[index].reason += ` Sarcasm cue: ${sarcasm.reason}.`;
    }
  }

  const positiveMass = sentimentTokens.reduce((sum, token) => sum + Math.max(0, token.weight), 0);
  const negativeMass = sentimentTokens.reduce((sum, token) => sum + Math.abs(Math.min(0, token.weight)), 0);
  const totalMass = positiveMass + negativeMass;
  const agreement = totalMass === 0 ? 0 : Math.abs(positiveMass - negativeMass) / totalMass;
  const meaningfulCount = Math.max(1, analyzedTokens.filter((token) => token.isWord || token.isEmoji).length);
  const density = Math.min(1, cueCount / meaningfulCount);
  let confidence;

  if (cueCount === 0) {
    confidence = 0.35;
  } else if (literalLabel === 'neutral') {
    confidence = clamp(0.58 + (1 - agreement) * 0.22 + density * 0.08, 0, 0.92);
  } else {
    confidence = clamp(0.5 + Math.abs(score) * 0.3 + agreement * 0.15 + density * 0.05, 0, 0.99);
  }

  if (sarcasm.detected) confidence = sarcasm.confidence;

  const emotions = emotionBreakdown(analyzedTokens, positiveMass, negativeMass);
  const publicSarcasm = {
    detected: sarcasm.detected,
    type: sarcasm.type,
    confidence: sarcasm.confidence,
    reason: sarcasm.reason,
    cueTokenIds: sarcasm.cueIndices.map((index) => analyzedTokens[index].id),
  };

  return {
    sentence: source,
    tokens: analyzedTokens,
    words: analyzedTokens.filter((token) => token.isWord || token.isEmoji),
    score,
    compound: score,
    label,
    literalLabel,
    sentiment: label,
    confidence: round(confidence),
    summary: sarcasm.detected
      ? buildSarcasmSummary(sarcasm, score, literalLabel)
      : buildSummary(label, analyzedTokens, positiveMass, negativeMass),
    sarcasm: publicSarcasm,
    emotions,
    breakdown: emotions,
  };
}

export default analyzeSentiment;
