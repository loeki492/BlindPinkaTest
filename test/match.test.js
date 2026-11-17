const { test } = require('node:test');
const assert = require('node:assert/strict');
const { isMatch, normalize } = require('../docs/match.js');

test('normalisation', () => {
  assert.equal(normalize('Bohemian Rhapsody - Remastered 2011'), 'bohemian rhapsody');
  assert.equal(normalize('Pokémon (Générique) [Live]'), 'pokemon');
  assert.equal(normalize('The Beatles'), 'beatles');
  assert.equal(normalize('Lose Yourself feat. X'), 'lose yourself');
});

test('réponses acceptées', () => {
  assert.ok(isMatch('bohemian rapsody', 'Bohemian Rhapsody - Remastered 2011')); // faute de frappe
  assert.ok(isMatch('beatles', 'The Beatles'));
  assert.ok(isMatch('POKEMON', 'Pokémon (Générique)'));
  assert.ok(isMatch('les chevaliers du zodiaque', 'Les Chevaliers du Zodiaque'));
  assert.ok(isMatch('chevaliers du zodiaque', 'Les Chevaliers du Zodiaque'));
});

test('réponses refusées', () => {
  assert.ok(!isMatch('queen', 'Bohemian Rhapsody'));
  assert.ok(!isMatch('a', 'ABBA'));
  assert.ok(!isMatch('', 'ABBA'));
  assert.ok(!isMatch('love', 'Love Me Tender Forever And Ever'));
});
