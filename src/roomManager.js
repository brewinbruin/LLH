'use strict';

const { v4: uuidv4 } = require('uuid');
const { initRound, checkMandatoryDiscard, resolveRound, CARD_DEFS } = require('./gameLogic');

const rooms = new Map();

function generateCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 4; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code;
}

function createRoom(hostName, hostSocketId) {
  let code;
  do { code = generateCode(); } while (rooms.has(code));

  const host = { id: uuidv4(), socketId: hostSocketId, name: hostName, hand: [], discards: [], eliminated: false, protected: false, wins: 0 };
  const room = {
    code,
    host: host.id,
    players: [host],
    phase: 'lobby',   // lobby | playing | round_end
    round: 0,
    currentPlayerIdx: 0,
    deck: [],
    removed: null,
    log: [],
    pendingAction: null,  // { type, actorIdx, ... }
    chat: [],
  };
  rooms.set(code, room);
  return { room, player: host };
}

function joinRoom(code, playerName, socketId) {
  const room = rooms.get(code.toUpperCase());
  if (!room) return { error: 'Room not found.' };

  // New player joining — only allowed in lobby phase
  if (room.phase !== 'lobby') return { error: 'This game is already in progress. You can only join before it starts.' };
  if (room.players.length >= 4) return { error: 'Room is full (max 4 players).' };

  // Block duplicate names — rejoin is handled separately via rejoin_room
  if (room.players.find(p => p.name.toLowerCase() === playerName.toLowerCase())) {
    return { error: 'That name is already taken in this room. Please use a different name.' };
  }

  const player = { id: uuidv4(), socketId, name: playerName, hand: [], discards: [], eliminated: false, protected: false, wins: 0 };
  room.players.push(player);
  return { room, player };
}

function reconnect(code, playerId, newSocketId) {
  const room = rooms.get(code);
  if (!room) return null;
  const p = room.players.find(p => p.id === playerId);
  if (!p) return null;
  p.socketId = newSocketId;
  return { room, player: p };
}

function removePlayer(socketId) {
  for (const [code, room] of rooms) {
    const idx = room.players.findIndex(p => p.socketId === socketId);
    if (idx !== -1) {
      const player = room.players[idx];
      if (room.phase === 'lobby') {
        // In lobby just remove them
        room.players.splice(idx, 1);
        if (room.players.length === 0) rooms.delete(code);
      } else {
        // Mid-game: mark eliminated and clear hand so game can continue
        player.eliminated = true;
        player.hand.forEach(c => player.discards.push(c));
        player.hand = [];
      }
      return { code, room, playerIdx: idx };
    }
  }
  return null;
}

function startGame(code) {
  const room = rooms.get(code);
  if (!room || room.players.length < 2) return { error: 'Need at least 2 players.' };
  room.round = 1;
  room.phase = 'playing';
  room.currentPlayerIdx = 0;
  _startRound(room);
  return { room };
}

function _startRound(room) {
  room.log = [];
  const { deck, removed } = initRound(room.players);
  room.deck  = deck;
  room.removed = removed;
  room.pendingAction = null;
  room.currentPlayerIdx = room.currentPlayerIdx % room.players.length;
  // Draw for first player
  _drawForCurrentPlayer(room);
}

function _drawForCurrentPlayer(room) {
  const p = room.players[room.currentPlayerIdx];
  if (!p || p.eliminated) return;
  if (room.deck.length > 0) p.hand.push(room.deck.pop());
  const mandatoryDiscard = checkMandatoryDiscard(p);
  if (mandatoryDiscard) {
    room.log.unshift(`${p.name} must discard Bilbo (mandatory).`);
  }
}

function playCard(code, playerId, cardUid, targetId, extra) {
  const room = rooms.get(code);
  if (!room) return { error: 'Room not found.' };

  const actorIdx = room.players.findIndex(p => p.id === playerId);
  if (actorIdx !== room.currentPlayerIdx) return { error: 'Not your turn.' };

  const actor = room.players[actorIdx];
  const cardIdx = actor.hand.findIndex(c => c.uid === cardUid);
  if (cardIdx === -1) return { error: 'Card not in hand.' };

  const card = actor.hand[cardIdx];
  actor.hand.splice(cardIdx, 1);
  actor.discards.push(card);

  let result = { log: null, modalFor: null, modalData: null };

  const target = targetId ? room.players.find(p => p.id === targetId) : null;

  // Helper: discard a card from a player's hand, auto-eliminate if Arkenstone
  const forceDiscard = (player, discardedCard, reason) => {
    player.discards.push(discardedCard);
    if (discardedCard.id === 'ark') {
      _eliminate(room, player, `Discarded the Arkenstone (${reason}).`);
      return true; // was arkenstone
    }
    return false;
  };

  switch (card.id) {
    case 'ring':
    case 'bilbo':
      result.log = `${actor.name} plays ${card.art} ${card.name} — no effect.`;
      result.broadcast = { type: 'info', msg: `${actor.name} played ${card.art} ${card.name}.` };
      break;

    case 'ark':
      // Playing the Arkenstone voluntarily = discarding it = eliminated
      _eliminate(room, actor, 'Played the Arkenstone (counts as discarding it).');
      result.log = `${actor.name} plays 💎 the Arkenstone — and is immediately eliminated!`;
      result.broadcast = { type: 'info', msg: `💎 ${actor.name} played the Arkenstone and is eliminated!` };
      break;

    case 'gandalf':
      actor.protected = true;
      result.log = `${actor.name} plays ${card.art} Gandalf — protected until next turn.`;
      result.broadcast = { type: 'info', msg: `${actor.name} played 🧙‍♂️ Gandalf and is now protected.` };
      break;

    case 'smaug': {
      if (!target || target.eliminated) { result.log = `${actor.name} plays 🐉 Smaug — no valid target (all protected). Card discarded with no effect.`; result.broadcast = { type: 'info', msg: `${actor.name} played 🐉 Smaug but had no valid target — all other players are protected by Gandalf.` }; break; }
      if (target.protected) {
        result.log = `${actor.name} plays Smaug on ${target.name} — but they are protected!`;
        result.broadcast = { type: 'info', msg: `${actor.name} played 🐉 Smaug on ${target.name} — but ${target.name} is protected by Gandalf!` };
        break;
      }
      const guessedCard = CARD_DEFS.find(c => c.id === extra.guessId);
      const hit = target.hand.some(c => c.id === extra.guessId);
      result.log = `${actor.name} plays 🐉 Smaug — names ${guessedCard?.name} for ${target.name}. ${hit ? `✓ Correct — ${target.name} eliminated!` : '✗ Wrong — no effect.'}`;
      if (hit) _eliminate(room, target, 'Smaug correctly named their card.');
      // All players get broadcast; actor+target get modal with details
      result.broadcast = {
        type: 'smaug',
        msg: `${actor.name} played 🐉 Smaug on ${target.name}, guessing ${guessedCard?.name}. ${hit ? `✓ Correct — ${target.name} eliminated!` : '✗ Wrong guess — no effect.'}`,
      };
      result.modalFor = [actor.id, target.id];
      result.modalData = {
        type: 'smaug_result',
        actorName: actor.name, targetName: target.name,
        guessedCard: guessedCard?.name || '?', hit,
      };
      break;
    }

    case 'bard': {
      if (!target || target.eliminated) { result.log = `${actor.name} plays 🏹 Bard — no valid target (all protected). Card discarded with no effect.`; result.broadcast = { type: 'info', msg: `${actor.name} played 🏹 Bard but had no valid target — all other players are protected by Gandalf.` }; break; }
      if (target.protected) {
        result.log = `${actor.name} plays Bard on ${target.name} — but they are protected!`;
        result.broadcast = { type: 'info', msg: `${actor.name} played 🏹 Bard on ${target.name} — but ${target.name} is protected!` };
        break;
      }
      result.log = `${actor.name} plays 🏹 Bard the Bowman — peeks at ${target.name}'s hand.`;
      // Everyone told it happened; actor gets private peek; target gets personal notice
      result.broadcast = { type: 'info', msg: `${actor.name} played 🏹 Bard and is secretly viewing ${target.name}'s hand.` };
      result.modalFor = playerId; // actor sees the card
      result.modalData = { type: 'bard_peek', targetName: target.name, cards: target.hand.map(c => ({ art: c.art, name: c.name, value: c.value })) };
      result.targetNotify = { playerId: target.id, msg: `👁 ${actor.name} used Bard and is now viewing your hand!` };
      break;
    }

    case 'legolas':
    case 'tauriel': {
      if (!target || target.eliminated) { result.log = `${actor.name} plays ${card.art} ${card.name} — no valid target (all protected). Card discarded with no effect.`; result.broadcast = { type: 'info', msg: `${actor.name} played ${card.art} ${card.name} but had no valid target — all other players are protected by Gandalf.` }; break; }
      if (target.protected) {
        result.log = `${actor.name} plays ${card.name} on ${target.name} — but they are protected!`;
        result.broadcast = { type: 'info', msg: `${actor.name} played ${card.art} ${card.name} on ${target.name} — but ${target.name} is protected!` };
        break;
      }
      const myCard    = actor.hand[0];
      const theirCard = target.hand[0];
      // One Ring is worth 0 during play — only worth 7 at round end
      const myVal     = myCard    ? myCard.value    : 0;
      const theirVal  = theirCard ? theirCard.value : 0;

      let loserName = null;
      if (myVal !== theirVal) {
        let loser;
        if (card.id === 'legolas') loser = myVal < theirVal ? actor : target;
        else                        loser = myVal > theirVal ? actor : target;
        loserName = loser.name;
        _eliminate(room, loser, `${card.name} comparison.`);
      }
      result.log = `${actor.name} plays ${card.art} ${card.name} vs ${target.name}. ${loserName ? loserName + ' eliminated!' : 'Tied — no elimination.'}`;
      // Everyone gets the outcome; the two involved get modal with card details
      result.broadcast = {
        type: 'compare_public',
        msg: `${actor.name} played ${card.art} ${card.name} against ${target.name}. ${loserName ? loserName + ' was eliminated!' : 'They tied — no elimination.'}`,
      };
      result.modalFor = [actor.id, target.id];
      result.modalData = {
        type: 'compare', cardName: card.name, art: card.art,
        actorName: actor.name, actorVal: myVal, actorCard: myCard?.name || '?',
        targetName: target.name, targetVal: theirVal, targetCard: theirCard?.name || '?',
        rule: card.id === 'legolas' ? 'Lower card eliminated' : 'Higher card eliminated',
        loser: loserName,
      };
      break;
    }

    case 'fili': {
      const ftarget = target || actor;
      const discardedCard = ftarget.hand[0];
      ftarget.hand = [];
      if (discardedCard) {
        const wasArk = forceDiscard(ftarget, discardedCard, 'Fili & Kili');
        if (wasArk) {
          result.log = `${actor.name} plays ⚒️ Fili & Kili on ${ftarget.name} — 💎 Arkenstone discarded, ${ftarget.name} eliminated!`;
          result.broadcast = { type: 'info', msg: `${actor.name} played ⚒️ Fili & Kili on ${ftarget.name} — ${ftarget.name} discarded the 💎 Arkenstone and is eliminated!` };
        } else if (room.deck.length > 0) {
          ftarget.hand.push(room.deck.pop());
          result.log = `${actor.name} plays ⚒️ Fili & Kili on ${ftarget.name} — they discard and redraw.`;
          result.broadcast = { type: 'info', msg: `${actor.name} played ⚒️ Fili & Kili on ${ftarget.name} — ${ftarget.name} discarded ${discardedCard.name} and drew a new card.` };
        } else {
          result.log = `${actor.name} plays ⚒️ Fili & Kili on ${ftarget.name} — they discard ${discardedCard.name} (no cards to draw).`;
          result.broadcast = { type: 'info', msg: `${actor.name} played ⚒️ Fili & Kili on ${ftarget.name} — ${ftarget.name} discarded ${discardedCard.name} (no cards left to draw).` };
        }
      } else {
        result.log = `${actor.name} plays ⚒️ Fili & Kili on ${ftarget.name} — no card to discard.`;
        result.broadcast = { type: 'info', msg: `${actor.name} played ⚒️ Fili & Kili on ${ftarget.name} — no card to discard.` };
      }
      break;
    }

    case 'thorin': {
      if (!target || target.eliminated) { result.log = `${actor.name} plays ⚔️ Thorin — no valid target (all protected). Card discarded with no effect.`; result.broadcast = { type: 'info', msg: `${actor.name} played ⚔️ Thorin but had no valid target — all other players are protected by Gandalf.` }; break; }
      if (target.protected) {
        result.log = `${actor.name} plays Thorin on ${target.name} — but they are protected!`;
        result.broadcast = { type: 'info', msg: `${actor.name} played ⚔️ Thorin on ${target.name} — but ${target.name} is protected!` };
        break;
      }
      const myC    = actor.hand[0]  || null;
      const theirC = target.hand[0] || null;
      // Check if either traded card is Arkenstone (Thorin is not discarding — hands swap, no elimination)
      actor.hand  = theirC ? [theirC] : [];
      target.hand = myC   ? [myC]   : [];
      result.log = `${actor.name} plays ⚔️ Thorin — trades hands with ${target.name}.`;
      result.broadcast = { type: 'info', msg: `${actor.name} played ⚔️ Thorin Oakenshield and swapped hands with ${target.name}.` };
      break;
    }
  }

  if (result.log) room.log.unshift(result.log);

  // Check round over
  const alive = room.players.filter(p => !p.eliminated);
  if (alive.length <= 1 || room.deck.length === 0) {
    return _endRound(room, result);
  }

  // Next turn
  _advanceTurn(room);
  return { room, result };
}

function _eliminate(room, player, reason) {
  player.eliminated = true;
  player.hand.forEach(c => player.discards.push(c));
  player.hand = [];
  room.log.unshift(`${player.name} is eliminated. ${reason}`);
}

function _advanceTurn(room) {
  let next = (room.currentPlayerIdx + 1) % room.players.length;
  let tries = 0;
  while (room.players[next].eliminated && tries < room.players.length) {
    next = (next + 1) % room.players.length;
    tries++;
  }
  room.currentPlayerIdx = next;
  room.players[next].protected = false;
  _drawForCurrentPlayer(room);
}

function _endRound(room, result = {}) {
  room.phase = 'round_end';
  const { winner } = resolveRound(room.players);
  if (winner) {
    winner.wins++;
    room.log.unshift(`🏆 ${winner.name} wins round ${room.round}!`);
  } else {
    room.log.unshift(`Round ${room.round} ends in a tie!`);
  }
  result.roundEnd = true;
  result.winner = winner ? { id: winner.id, name: winner.name } : null;
  return { room, result };
}

function nextRound(code) {
  const room = rooms.get(code);
  if (!room) return { error: 'Room not found.' };
  room.round++;
  room.phase = 'playing';
  room.currentPlayerIdx = (room.currentPlayerIdx + 1) % room.players.length;
  _startRound(room);
  return { room };
}

function addChat(code, playerId, message) {
  const room = rooms.get(code);
  if (!room) return null;
  const player = room.players.find(p => p.id === playerId);
  if (!player) return null;
  const entry = { name: player.name, message: message.slice(0, 200), ts: Date.now() };
  room.chat.push(entry);
  if (room.chat.length > 50) room.chat.shift();
  return entry;
}

function getRoom(code) { return rooms.get(code) || null; }

// Public view: hides other players' hands
function publicState(room, forPlayerId) {
  return {
    code: room.code,
    phase: room.phase,
    round: room.round,
    currentPlayerIdx: room.currentPlayerIdx,
    deckCount: room.deck.length,
    log: room.log.slice(0, 15),
    chat: room.chat.slice(-20),
    players: room.players.map(p => {
      const isMe = p.id === forPlayerId;
      return {
        id: p.id,
        name: p.name,
        wins: p.wins,
        eliminated: p.eliminated,
        protected: p.protected,
        handCount: p.hand.length,
        discards: p.discards.map(c => ({ value: c.value, id: c.id, name: c.name, art: c.art })),
        hand: isMe ? p.hand.map(c => ({ uid: c.uid, id: c.id, name: c.name, value: c.value, art: c.art, effect: c.effect })) : [],
        isMe,
      };
    }),
  };
}

// End-of-round reveals all hands
function revealState(room) {
  return {
    ...publicState(room, null),
    players: room.players.map(p => ({
      id: p.id,
      name: p.name,
      wins: p.wins,
      eliminated: p.eliminated,
      protected: p.protected,
      handCount: p.hand.length,
      discards: p.discards.map(c => ({ value: c.value, id: c.id, name: c.name, art: c.art })),
      hand: p.hand.map(c => ({ uid: c.uid, id: c.id, name: c.name, value: c.value, art: c.art, effect: c.effect })),
      isMe: false,
    })),
  };
}

module.exports = { createRoom, joinRoom, reconnect, removePlayer, startGame, playCard, nextRound, addChat, getRoom, publicState, revealState };
