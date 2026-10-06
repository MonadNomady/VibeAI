import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeSentiment, tokenizeSentence } from '../sentiment.js';

test('tokenization preserves contractions, punctuation, and emoji for display', () => {
  const tokens = tokenizeSentence("Wow, I can't believe this 😊!!!");

  assert.deepEqual(
    tokens.map(({ text }) => text),
    ['Wow', ',', 'I', "can't", 'believe', 'this', '😊', '!!!'],
  );
  assert.equal(tokens[3].normalized, "can't");
  assert.equal(tokens[3].isWord, true);
  assert.equal(tokens[6].isEmoji, true);
  assert.equal(tokens[7].isPunctuation, true);
  assert.equal(tokens[0].id, 'token-0');
});

test('positive and negative language produce bounded, explainable results', () => {
  const positive = analyzeSentiment('This is wonderful and fun.');
  const negative = analyzeSentiment('This is awful and boring.');

  assert.equal(positive.label, 'positive');
  assert(positive.score > 0);
  assert.equal(negative.label, 'negative');
  assert(negative.score < 0);
  assert.match(positive.summary, /positive/i);
  assert.match(negative.summary, /negative/i);

  for (const result of [positive, negative]) {
    assert(result.confidence >= 0 && result.confidence <= 1);
    assert(result.tokens.every((token) => token.weight >= -1 && token.weight <= 1));
    assert(result.tokens.every((token) => typeof token.reason === 'string' && token.reason.length > 0));
  }
});

test('negation reverses the next nearby sentiment cue', () => {
  const ordinary = analyzeSentiment('This is good.');
  const negated = analyzeSentiment('This is not good.');
  const good = negated.tokens.find((token) => token.normalized === 'good');
  const not = negated.tokens.find((token) => token.normalized === 'not');

  assert.equal(ordinary.label, 'positive');
  assert.equal(negated.label, 'negative');
  assert(good.weight < 0);
  assert.match(good.reason, /negation reverses/i);
  assert.equal(not.role, 'modifier');
});

test('intensifiers and downtoners change the word weight', () => {
  const plain = analyzeSentiment('good');
  const intensified = analyzeSentiment('very good');
  const softened = analyzeSentiment('slightly good');
  const getGood = (result) => result.tokens.find((token) => token.normalized === 'good').weight;

  assert(getGood(intensified) > getGood(plain));
  assert(getGood(softened) < getGood(plain));
  assert.match(intensified.tokens.at(-1).reason, /strengthens/i);
  assert.match(softened.tokens.at(-1).reason, /softens/i);
});

test('the clause after a contrast receives more influence', () => {
  const result = analyzeSentiment('The idea is good, but the result is terrible.');
  const good = result.tokens.find((token) => token.normalized === 'good');
  const terrible = result.tokens.find((token) => token.normalized === 'terrible');
  const but = result.tokens.find((token) => token.normalized === 'but');

  assert.equal(result.label, 'negative');
  assert(Math.abs(terrible.weight) > Math.abs(good.weight));
  assert.equal(but.role, 'contrast');
  assert.match(terrible.reason, /more influence after/i);
});

test('exclamation punctuation and all-caps add emphasis without exceeding bounds', () => {
  const plain = analyzeSentiment('great');
  const emphatic = analyzeSentiment('GREAT!!!');
  const plainGreat = plain.tokens.find((token) => token.normalized === 'great');
  const emphaticGreat = emphatic.tokens.find((token) => token.normalized === 'great');
  const punctuation = emphatic.tokens.find((token) => token.text === '!!!');

  assert(emphaticGreat.weight > plainGreat.weight);
  assert(emphaticGreat.weight <= 1);
  assert.equal(punctuation.role, 'emphasis');
  assert.match(emphaticGreat.reason, /Capital letters add emphasis/i);
});

test('common emoji contribute sentiment while preserving their original text', () => {
  const happy = analyzeSentiment('Okay 😊');
  const sad = analyzeSentiment('Okay 😭');

  assert.equal(happy.label, 'positive');
  assert.equal(sad.label, 'negative');
  assert(happy.tokens.find((token) => token.text === '😊').weight > 0);
  assert(sad.tokens.find((token) => token.text === '😭').weight < 0);
});

test('gratitude and common positive slang are recognized', () => {
  for (const input of ['Thank you!', 'Thanks!', 'I appreciate your help.', 'This song slaps!']) {
    const result = analyzeSentiment(input);
    assert.equal(result.label, 'positive', input);
    assert(result.tokens.some((token) => token.weight > 0), input);
  }
});

test('positive wording and a negative emoji are combined without inferring sarcasm', () => {
  const result = analyzeSentiment('Great job 🙄');
  const great = result.tokens.find((token) => token.normalized === 'great');
  const eyeRoll = result.tokens.find((token) => token.text === '🙄');

  assert(['positive', 'negative', 'neutral'].includes(result.label));
  assert(great.weight > 0);
  assert(eyeRoll.weight < 0);
  assert.equal('sarcasm' in result, false);
  assert.equal('sarcasmCue' in great, false);
  assert.doesNotMatch(result.summary, /sarcas/i);
});

test('sarcastic phrases receive only a literal sentiment reading', () => {
  const disbelief = analyzeSentiment('Yeah, right!');
  const sarcasticThanks = analyzeSentiment('Thanks so much for the terrible service.');
  const literalPraise = analyzeSentiment('Sure, I totally love doing homework all weekend.');

  assert.equal(disbelief.label, 'neutral');
  assert.equal(disbelief.score, 0);
  assert(sarcasticThanks.tokens.find((token) => token.normalized === 'thanks').weight > 0);
  assert(sarcasticThanks.tokens.find((token) => token.normalized === 'terrible').weight < 0);
  assert.equal(literalPraise.label, 'positive');
  assert(literalPraise.tokens.find((token) => token.normalized === 'love').weight > 0);
  assert.equal('sarcasm' in disbelief, false);
  assert.equal('literalLabel' in disbelief, false);
});

test('balanced opposing cues are reported as mixed or neutral', () => {
  const result = analyzeSentiment('I love it and hate it.');

  assert.equal(result.label, 'neutral');
  assert(Math.abs(result.score) <= 0.12);
  assert.match(result.summary, /mixed|balanced/i);
  assert(result.emotions.positive > 0);
  assert(result.emotions.negative > 0);
  assert(Math.abs(
    result.emotions.positive + result.emotions.negative + result.emotions.neutral - 1,
  ) < 0.002);
});

test('empty or unknown text returns a safe neutral result', () => {
  for (const input of ['', 'The book is on the table.']) {
    const result = analyzeSentiment(input);
    assert.equal(result.label, 'neutral');
    assert.equal(result.score, 0);
    assert.equal(result.confidence, 0.35);
    assert.match(result.summary, /No strong/i);
  }
});
