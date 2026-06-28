'use strict';

const CARD_DEFS = [
  { id: 'ring',   name: 'The One Ring',      value: 0, endValue: 7, count: 1, art: '💍', effect: 'No effect. Worth 7 at round end.' },
  { id: 'smaug',  name: 'Smaug',             value: 1, endValue: 1, count: 5, art: '🐉', effect: 'Name a card (not Smaug). If target holds it, they are eliminated.' },
  { id: 'bard',   name: 'Bard the Bowman',   value: 2, endValue: 2, count: 2, art: '🏹', effect: 'Secretly look at another player\'s hand.' },
  { id: 'legolas',name: 'Legolas',            value: 3, endValue: 3, count: 1, art: '🧝', effect: 'Compare hands. Lower card is eliminated.' },
  { id: 'tauriel',name: 'Tauriel',            value: 3, endValue: 3, count: 1, art: '🌿', effect: 'Compare hands. Higher card is eliminated.' },
  { id: 'gandalf',name: 'Gandalf the Grey',  value: 4, endValue: 4, count: 2, art: '🧙‍♂️', effect: 'Protected from other players until your next turn.' },
  { id: 'fili',   name: 'Fili & Kili',       value: 5, endValue: 5, count: 2, art: '⚒️',  effect: 'Target discards their hand and draws new card. Discarding Arkenstone = eliminated.' },
  { id: 'thorin', name: 'Thorin Oakenshield', value: 6, endValue: 6, count: 1, art: '⚔️',  effect: 'Trade hands with another player.' },
  { id: 'bilbo',  name: 'Bilbo Baggins',     value: 7, endValue: 7, count: 1, art: 'PIPE_SVG', effect: 'No effect. Must discard if held with Fili&Kili(5) or Thorin(6).' },
  { id: 'ark',    name: 'Arkenstone',        value: 8, endValue: 8, count: 1, art: '💎', effect: 'Highest card. If discarded for any reason, immediately eliminated.' },
];

function buildDeck() {
  const deck = [];
  CARD_DEFS.forEach(def => {
    for (let i = 0; i < def.count; i++) {
      deck.push({ ...def, uid: `${def.id}_${i}_${Date.now()}_${Math.random()}` });
    }
  });
  return shuffle(deck);
}

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function getEndValue(card) {
  return card.id === 'ring' ? 7 : card.value;
}

function initRound(players) {
  const deck = buildDeck();
  const removed = deck.pop(); // Remove 1 face-down

  players.forEach(p => {
    p.hand = [deck.pop()];
    p.discards = [];
    p.eliminated = false;
    p.protected = false;
  });

  return { deck, removed };
}

function checkMandatoryDiscard(player) {
  const vals = player.hand.map(c => c.value);
  const hasBilbo = vals.includes(7);
  const hasFili  = vals.includes(5);
  const hasThorin = vals.includes(6);
  if (hasBilbo && (hasFili || hasThorin)) {
    const bilbo = player.hand.find(c => c.value === 7);
    player.hand = player.hand.filter(c => c.value !== 7);
    player.discards.push(bilbo);
    return bilbo;
  }
  return null;
}

function resolveRound(players) {
  const alive = players.filter(p => !p.eliminated);

  const getVal = p => p.hand.length > 0 ? getEndValue(p.hand[0]) : -1;
  const maxVal = Math.max(...alive.map(getVal));
  const tied = alive.filter(p => getVal(p) === maxVal);

  let winner = null;
  if (tied.length === 1) {
    winner = tied[0];
  } else {
    const sumDiscards = p => p.discards.reduce((a, c) => a + (c.value === 0 ? 0 : c.value), 0);
    const maxDiscard  = Math.max(...tied.map(sumDiscards));
    const tiedD       = tied.filter(p => sumDiscards(p) === maxDiscard);
    if (tiedD.length === 1) winner = tiedD[0];
  }

  return { winner, alive };
}

module.exports = { CARD_DEFS, buildDeck, initRound, checkMandatoryDiscard, resolveRound, getEndValue, shuffle };
