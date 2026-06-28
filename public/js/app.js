'use strict';

// ── STATE ────────────────────────────────────────────────────────────────────
let chatUnread = 0;
const S = {
  socket: null,
  playerId: null,
  roomCode: null,
  playerName: null,
  state: null,
  selectedCard: null,
  isHost: false,
  phase: 'lobby',
  isReconnecting: false,
};

const CARD_DEFS = [
  { id:'ring',    name:'The One Ring',      value:0,  art:'💍', effect:'No effect during play. Worth 7 at round end — can beat Thorin(6), ties Bilbo(7).' },
  { id:'smaug',   name:'Smaug',             value:1,  art:'🐉', effect:'Choose a player, name any card except Smaug. If they hold it, they are eliminated.' },
  { id:'bard',    name:'Bard the Bowman',   value:2,  art:'🏹', effect:'Secretly look at another player\'s hand.' },
  { id:'legolas', name:'Legolas',           value:3,  art:'🧝', effect:'Compare hands with a player. The LOWER card is eliminated.' },
  { id:'tauriel', name:'Tauriel',           value:3,  art:'🌿', effect:'Compare hands with a player. The HIGHER card is eliminated.' },
  { id:'gandalf', name:'Gandalf the Grey',  value:4,  art:'🧙‍♂️', effect:'Protected from all effects until your next turn (must still obey mandatory discard).' },
  { id:'fili',    name:'Fili & Kili',       value:5,  art:'⚒️',  effect:'Any player (inc. yourself) discards their hand and draws a new card. Discarding Arkenstone = eliminated.' },
  { id:'thorin',  name:'Thorin Oakenshield',value:6,  art:'⚔️',  effect:'Trade hands with another player. Mandatory discard rule: if you hold this with Bilbo(7), discard Bilbo.' },
  { id:'bilbo',   name:'Bilbo Baggins',     value:7,  art:'PIPE_SVG', effect:'No effect when played. Mandatory discard: if held with Fili&Kili(5) or Thorin(6), must discard Bilbo.' },
  { id:'ark',     name:'Arkenstone',        value:8,  art:'💎', effect:'Highest card. No effect. If discarded for any reason, immediately eliminated.' },
];

// ── INIT ─────────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  S.socket = io({
    reconnection: true,
    reconnectionAttempts: Infinity,
    reconnectionDelay: 1000,
    reconnectionDelayMax: 10000,
    timeout: 60000,
  });
  S.isReconnecting = false;
  bindSocketEvents();
  bindUIEvents();
  renderGuideCards();

  // Fresh page load always shows lobby — never auto-rejoin
  // (rejoin only happens on socket DROP/reconnect via isReconnecting flag)
  const session = loadSession();
  if (session.name) qs('#player-name').value = session.name;
  if (session.code) qs('#room-code').value = session.code;
  showScreen('lobby');
});



function saveSession() {
  try {
    localStorage.setItem('ll_code', S.roomCode);
    localStorage.setItem('ll_name', S.playerName || '');
  } catch(e) {}
  // URL hash fallback for Samsung Internet
  try {
    const encoded = btoa(JSON.stringify({ code: S.roomCode, name: S.playerName }));
    history.replaceState(null, '', '#' + encoded);
  } catch(e) {}
}
function clearSession() {
  try { localStorage.removeItem('ll_code'); localStorage.removeItem('ll_name'); } catch(e) {}
  try { history.replaceState(null, '', window.location.pathname); } catch(e) {}
}
function loadSession() {
  try {
    const code = localStorage.getItem('ll_code');
    const name = localStorage.getItem('ll_name');
    if (code && name) return { code, name };
  } catch(e) {}
  // Fallback: URL hash
  try {
    const hash = window.location.hash.slice(1);
    if (hash) {
      const parsed = JSON.parse(atob(hash));
      if (parsed.code && parsed.name) return parsed;
    }
  } catch(e) {}
  return {};
}

// ── SOCKET EVENTS ────────────────────────────────────────────────────────────
function bindSocketEvents() {
  S.socket.on('state_update', state => {
    S.state = state;
    if (state.phase === 'playing') {
      if (S.phase !== 'game') showScreen('game'); // transition once
      renderGame();
    }
  });
  S.socket.on('room_update', state => {
    // Update waiting room whenever we're on the waiting screen
    if (S.phase === 'waiting') {
      S.state = state;
      renderWaiting();
    }
  });
  S.socket.on('round_end', ({ state, winner }) => {
    S.state = state;
    clearSession(); // clear so returning to browser after round goes to lobby
    renderRoundEnd(winner);
    showScreen('round-end');
  });
  S.socket.on('show_modal', data => { if (data.type === 'smaug_result') showSmaugModal(data); else showCompareModal(data); });
  S.socket.on('private_modal', data => showBardModal(data));
  S.socket.on('chat_msg', entry => appendChatLog(entry));
  S.socket.on('room_dissolved', ({ reason }) => {
    clearSession();
    S.playerId = null; S.roomCode = null; S.state = null;
    S.selectedCard = null; S.isHost = false;
    closeChat(); closeLog();
    showScreen('lobby');
    // Show reason in lobby error field after a tick so screen has switched
    setTimeout(() => {
      const err = qs('#lobby-error');
      if (err) err.textContent = reason;
    }, 50);
  });
  S.socket.on('rejoin_result', res => {
    if (res.error) {
      showReconnectBanner(false);
      showError(res.error);
      return;
    }
    S.playerId = res.playerId;
    S.roomCode = res.code;
    S.playerName = res.name;
    S.state = res.state;
    S.isHost = res.state?.players?.[0]?.id === res.playerId;
    saveSession();
    applyState(res.state);
  });
  S.socket.on('game_notice', data => showNotice(data.msg));
  S.socket.on('personal_notice', data => showNotice(data.msg, true));
  S.socket.on('player_left', ({ name }) => appendLog(`${name} left the game.`));
  S.socket.on('disconnect', () => {
    S.isReconnecting = true;
    // Load session into memory now in case page was refreshed
    const session = loadSession();
    if (!S.roomCode && session.code) S.roomCode = session.code;
    if (!S.playerName && session.name) S.playerName = session.name;
    appendLog('Disconnected. Trying to reconnect…');
    showReconnectBanner(true);
  });

  S.socket.on('connect', () => {
    showReconnectBanner(false);
    // Only auto-rejoin on a genuine socket drop — not on fresh page load
    if (!S.isReconnecting) return;
    // Rejoin if we were in a room (waiting, mid-game, or round-end)
    // but NOT if we're just on the lobby screen with no room
    if (!S.roomCode || !S.playerName) {
      S.isReconnecting = false;
      return;
    }
    S.socket.emit('rejoin_room', { code: S.roomCode, name: S.playerName });
    S.isReconnecting = false;
  });

  // When tab becomes visible again - rejoin if we have an active room
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      if (!S.roomCode || !S.playerName) return;
      if (S.phase === 'lobby') return;
      // Rejoin from any screen: waiting, game, or round-end
      if (!S.socket.connected) {
        S.socket.connect();
      } else if (!S.socket.id) {
        S.socket.connect();
      } else {
        // Send rejoin to refresh socket membership in the room
        S.socket.emit('rejoin_room', { code: S.roomCode, name: S.playerName });
      }
    }
  });
}

function applyState(state) {
  S.state = state;
  // Determine isHost: check isMe first, then fall back to S.playerId match
  const me = state.players.find(p => p.isMe);
  if (me) {
    S.isHost = state.players[0]?.id === me.id;
  } else if (S.playerId) {
    S.isHost = state.players[0]?.id === S.playerId;
  }

  if (state.phase === 'lobby') {
    // Waiting room — game not started yet, host must press Start
    renderWaiting();
    showScreen('waiting');
  } else if (state.phase === 'playing') {
    renderGame();
    showScreen('game');
  } else if (state.phase === 'round_end') {
    renderRoundEnd(state.winner || null);
    showScreen('round-end');
  }
}

// ── UI EVENTS ────────────────────────────────────────────────────────────────
function bindUIEvents() {
  // Lobby
  qs('#btn-create').onclick = () => {
    const name = qs('#player-name').value.trim();
    if (!name) return showError('Enter your name.');
    S.socket.emit('create_room', { name }, res => {
      if (res.error) return showError(res.error);
      S.playerId = res.playerId;
      S.roomCode = res.code;
      S.playerName = name;
      S.isHost = true;
      S.state = res.state;
      saveSession();
      renderWaiting();
      showScreen('waiting');
    });
  };
  qs('#btn-join').onclick = joinRoom;
  qs('#room-code').onkeydown = e => { if (e.key === 'Enter') joinRoom(); };
  qs('#player-name').onkeydown = e => { if (e.key === 'Enter') qs('#btn-create').click(); };

  // Waiting
  qs('#btn-start').onclick = () => {
    S.socket.emit('start_game', {}, res => {
      if (res?.error) alert(res.error);
      // Don't navigate here — state_update from server drives screen transition
    });
  };
  qs('#btn-copy-code').onclick = () => {
    navigator.clipboard.writeText(S.roomCode).then(() => {
      qs('#btn-copy-code').textContent = 'Copied!';
      setTimeout(() => qs('#btn-copy-code').textContent = 'Copy code', 2000);
    }).catch(() => {
      prompt('Room code:', S.roomCode);
    });
  };

  // Quit buttons
  qs('#btn-quit-game').onclick = () => {
    if (!confirm('Leave the game? You will exit the room.')) return;
    quitGame();
  };
  qs('#btn-quit-lobby').onclick = () => {
    if (!confirm('Leave the room?')) return;
    quitGame();
  };
  qs('#btn-quit-round').onclick = () => {
    if (!confirm('Leave the game? You will exit the room.')) return;
    quitGame();
  };

  // Log FAB + drawer
  qs('#btn-log-fab').onclick = openLog;
  qs('#btn-log-close').onclick = closeLog;
  qs('#log-backdrop').onclick = closeLog;

  // Guide FAB (in-game)
  qs('#btn-guide-fab').onclick = () => qs('#guide-overlay').style.display = 'flex';

  // Chat FAB + drawer
  qs('#btn-chat-fab').onclick = openChat;
  qs('#btn-chat-close').onclick = closeChat;
  qs('#chat-backdrop').onclick = closeChat;
  qs('#btn-chat-send').onclick = sendChat;
  qs('#chat-input').onkeydown = e => { if (e.key === 'Enter') sendChat(); };

  // Round end
  qs('#btn-next-round').onclick = () => {
    S.socket.emit('next_round', {}, res => {
      if (res?.error) alert(res.error);
      else showScreen('game');
    });
  };

  // Guide
  qs('#btn-rules-lobby').onclick = () => qs('#guide-overlay').style.display = 'flex';

  // Auto-join from URL param
  const params = new URLSearchParams(location.search);
  if (params.get('join')) qs('#room-code').value = params.get('join').toUpperCase();
}

function joinRoom() {
  const name = qs('#player-name').value.trim();
  const code = qs('#room-code').value.trim().toUpperCase();
  if (!name) return showError('Enter your name.');
  if (!code) return showError('Enter a room code.');
  S.socket.emit('join_room', { name, code }, res => {
    if (res.error) {
      // If game in progress OR name taken, try rejoining as a returning player
      if (res.error.includes('already in progress') || res.error.includes('already taken')) {
        S.socket.emit('rejoin_room', { name, code }, () => {});
        // rejoin_result handler will take over from here
        return;
      }
      return showError(res.error);
    }
    S.playerId = res.playerId;
    S.roomCode = res.code;
    S.playerName = name;
    S.isHost = false;
    S.state = res.state;
    saveSession();
    renderWaiting();
    showScreen('waiting');
  });
}

function sendChat() {
  const inp = qs('#chat-input');
  const msg = inp.value.trim();
  if (!msg) return;
  S.socket.emit('chat', { message: msg });
  inp.value = '';
}

// ── RENDER WAITING ───────────────────────────────────────────────────────────
function renderWaiting() {
  const state = S.state;
  if (!state) return;
  qs('#display-code').textContent = state.code;
  const wp = qs('#waiting-players');
  wp.innerHTML = '';
  state.players.forEach((p, i) => {
    const div = document.createElement('div');
    div.className = 'waiting-player';
    div.innerHTML = `<div class="wp-dot"></div><span class="wp-name">${esc(p.name)}</span>${i===0?'<span class="wp-host">Host</span>':''}`;
    wp.appendChild(div);
  });

  // Host check: use both playerId match and isHost flag as fallback
  const isHost = S.isHost || state.players[0]?.id === S.playerId;
  qs('#btn-start').style.display = isHost && state.players.length >= 2 ? 'block' : 'none';
  qs('#waiting-status').style.display = isHost ? 'none' : 'block';
}

// ── RENDER GAME ──────────────────────────────────────────────────────────────
function renderGame() {
  const state = S.state;
  if (!state) return;
  showScreen('game');

  const me = state.players.find(p => p.isMe);
  const currentP = state.players[state.currentPlayerIdx];
  const isMyTurn = me && currentP?.id === me.id && !me.eliminated;

  qs('#g-round').textContent = `Round ${state.round}`;
  qs('#g-turn').textContent = isMyTurn ? 'Your turn!' : `${currentP?.name || '?'}'s turn`;
  qs('#g-deck').textContent = `🂠 ${state.deckCount}`;

  // All players panel (opponents + self)
  const oppRow = qs('#opponents-row');
  oppRow.innerHTML = '';
  state.players.forEach((p) => {
    const isActive = state.players[state.currentPlayerIdx]?.id === p.id;
    const div = document.createElement('div');
    div.className = `opp-card${isActive?' active-turn':''}${p.eliminated?' eliminated':''}${p.protected?' protected':''}${p.isMe?' opp-me':''}`;
    const status = p.eliminated ? 'Eliminated' : p.protected ? '🛡 Protected' : p.isMe ? 'You' : `${p.handCount} card${p.handCount!==1?'s':''}`;
    div.innerHTML = `
      <div class="opp-name">${esc(p.name)}${p.isMe?' <span class="you-tag">(you)</span>':''}</div>
      <div class="opp-status">${status}</div>
      <div class="opp-wins">Wins: ${p.wins}</div>
      <div class="opp-discards">${p.discards.map(c=>`<span class="opp-disc-chip" title="${c.name}">${renderArt(c.art,14)}${c.value}</span>`).join('')}</div>`;
    oppRow.appendChild(div);
  });

  // My hand
  const handArea = qs('#my-hand');
  const handLabel = qs('#hand-label');
  if (!me) return;
  handLabel.textContent = isMyTurn ? 'Tap a card to play' : `${me.name}'s hand`;
  handArea.innerHTML = '';
  me.hand.forEach(card => {
    const div = document.createElement('div');
    const isSelected = S.selectedCard?.uid === card.uid;
    div.className = `play-card card-${card.id}${isSelected?' selected':''}`;
    const artHtml = card.art === 'PIPE_SVG'
      ? `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 36 36" width="42" height="42"><rect x="18" y="16" width="10" height="12" rx="3" fill="#8B4513" stroke="#5C2E00" stroke-width="1.2"/><rect x="4" y="23" width="16" height="4" rx="2" fill="#8B4513" stroke="#5C2E00" stroke-width="1.2"/><ellipse cx="4" cy="25" rx="2" ry="2.5" fill="#6B3410"/><ellipse cx="23" cy="11" rx="4" ry="2.5" fill="none" stroke="#aaa" stroke-width="1.2" opacity="0.8"/><ellipse cx="21" cy="6" rx="3" ry="1.8" fill="none" stroke="#aaa" stroke-width="1" opacity="0.5"/><ellipse cx="24" cy="2" rx="2" ry="1.2" fill="none" stroke="#aaa" stroke-width="0.8" opacity="0.3"/></svg>`
      : `<span class="cart">${card.art}</span>`;
    div.innerHTML = `<span class="cv">${card.value}</span>${artHtml}<span class="cname">${card.name}</span><span class="cv2">${card.value}</span>`;
    if (isMyTurn) div.onclick = () => selectCard(card);
    handArea.appendChild(div);
  });

  // Also render discard chips for me
  // Action panel
  if (!isMyTurn || me.eliminated) {
    qs('#action-content').innerHTML = `<p class="action-idle">${me.eliminated ? 'You are eliminated.' : 'Waiting for ' + (currentP?.name||'?') + '…'}</p>`;
    renderLog(state);
    return;
  }
  if (!S.selectedCard || !me.hand.find(c => c.uid === S.selectedCard?.uid)) {
    S.selectedCard = null;
    qs('#action-content').innerHTML = `<p class="action-idle">Tap a card to play it</p>`;
    renderLog(state);
    return;
  }
  // Always re-render action panel with fresh state so protected players
  // are excluded from target buttons even if state arrived after card was selected
  renderActionPanel(state, me);

  // Log
  renderLog(state);
}

function selectCard(card) {
  S.selectedCard = card;
  renderGame();
}

function renderActionPanel(state, me) {
  const card = S.selectedCard;
  const others = state.players.filter(p => !p.eliminated && !p.isMe);
  const validTargets = others.filter(p => !p.protected);

  // Build HTML using data-attributes only — no inline onclick handlers
  // (inline handlers are blocked by Chrome mobile on some Android/Samsung devices)
  let html = `<div class="action-card-name">${card.art === 'PIPE_SVG' ? renderArt(card.art, 20) : card.art} ${card.name} (${card.value})</div>
    <div class="action-effect">${card.effect}</div>
    <div class="action-btns" id="action-btn-group" style="margin-top:8px">`;

  const noTarget = () => {
    html += `<p class="action-effect" style="color:#d09050;margin-bottom:6px">All other players are protected by Gandalf — no valid target. Playing this card discards it with no effect.</p>`;
    html += `<button class="action-btn confirm" data-action="play" data-target="">Discard — no effect</button>`;
  };

  if (['ring','bilbo','ark','gandalf'].includes(card.id)) {
    html += `<button class="action-btn confirm" data-action="play" data-target="">Play ${card.name}</button>`;
  } else if (card.id === 'smaug') {
    if (validTargets.length === 0) { noTarget(); }
    else {
      html += `<p class="action-prompt">Choose a target:</p>`;
      validTargets.forEach(p => {
        html += `<button class="action-btn" data-action="smaug" data-target="${p.id}" data-name="${esc(p.name)}">${esc(p.name)}</button>`;
      });
    }
  } else if (card.id === 'bard') {
    if (validTargets.length === 0) { noTarget(); }
    else validTargets.forEach(p => html += `<button class="action-btn" data-action="play" data-target="${p.id}">${esc(p.name)}</button>`);
  } else if (card.id === 'legolas' || card.id === 'tauriel') {
    if (validTargets.length === 0) { noTarget(); }
    else validTargets.forEach(p => html += `<button class="action-btn" data-action="play" data-target="${p.id}">${esc(p.name)}</button>`);
  } else if (card.id === 'fili') {
    const allAlive = state.players.filter(p => !p.eliminated && (!p.protected || p.isMe));
    html += `<p class="action-prompt">Choose a target (or yourself):</p>`;
    allAlive.forEach(p => html += `<button class="action-btn" data-action="play" data-target="${p.id}">${esc(p.name)}${p.isMe?' (you)':''}</button>`);
  } else if (card.id === 'thorin') {
    if (validTargets.length === 0) { noTarget(); }
    else validTargets.forEach(p => html += `<button class="action-btn" data-action="play" data-target="${p.id}">${esc(p.name)}</button>`);
  }

  html += `</div>`;
  const ac = qs('#action-content');
  ac.innerHTML = html;

  // Attach event listener to the button group (event delegation, no inline handlers)
  const btnGroup = qs('#action-btn-group');
  if (btnGroup) {
    btnGroup.addEventListener('click', e => {
      const btn = e.target.closest('button[data-action]');
      if (!btn) return;
      const action = btn.dataset.action;
      const targetId = btn.dataset.target || null;
      const targetName = btn.dataset.name || '';
      if (action === 'play') {
        submitPlay(targetId || null);
      } else if (action === 'smaug') {
        smaugPickTarget(targetId, targetName);
      }
    });
  }
}

// ── CARD ACTIONS ─────────────────────────────────────────────────────────────
function submitPlay(targetId, extra) {
  if (!S.selectedCard) return;
  S.socket.emit('play_card', { cardUid: S.selectedCard.uid, targetId, extra: extra || {} }, res => {
    if (res?.error) { alert(res.error); return; }
    S.selectedCard = null;
  });
}

function smaugPickTarget(targetId, targetName) {
  const otherCards = CARD_DEFS.filter(c => c.id !== 'smaug');
  const btns = otherCards.map(c =>
    `<button class="modal-btn" style="min-width:130px;text-align:left" data-action="smaug-guess" data-target="${targetId}" data-guess="${c.id}">
      ${renderArt(c.art, 18)} ${c.name} (${c.value})
    </button>`
  ).join('');
  showModal(
    `🐉 Smaug — Name a Card`,
    `What card do you think <strong>${esc(targetName)}</strong> holds?`,
    btns
  );

  // Attach listener to modal buttons after render
  setTimeout(() => {
    const modalBtns = qs('#modal-btns');
    if (modalBtns) {
      modalBtns.addEventListener('click', e => {
        const btn = e.target.closest('button[data-action="smaug-guess"]');
        if (!btn) return;
        closeModal();
        submitPlay(btn.dataset.target, { guessId: btn.dataset.guess });
      });
    }
  }, 0);
}

// ── ROUND END ────────────────────────────────────────────────────────────────
function renderRoundEnd(winner) {
  const state = S.state;
  qs('#re-title').textContent = winner ? `${winner.name} wins the round!` : 'Round ends in a tie!';

  const results = qs('#re-results');
  results.innerHTML = `<div style="font-size:12px;color:var(--parch3);font-style:italic;margin-bottom:6px">Round ${state.round} — hands revealed</div>`;

  const alive = state.players.filter(p => !p.eliminated);
  const elim  = state.players.filter(p => p.eliminated);
  [...alive, ...elim].forEach(p => {
    const cardStr = p.hand.length > 0
      ? `${p.hand[0].art} ${p.hand[0].name} (${p.hand[0].id==='ring'?'0→7':p.hand[0].value})`
      : 'Eliminated';
    const isW = winner && p.id === winner.id;
    const row = document.createElement('div');
    row.className = 're-row';
    row.innerHTML = `<span class="re-row-name${isW?' winner':''}">${isW?'★ ':''}${esc(p.name)}</span>
      <span class="re-row-detail">${cardStr} · ${p.wins} win${p.wins!==1?'s':''}</span>`;
    results.appendChild(row);
  });

  const reLog = qs('#re-log');
  reLog.innerHTML = state.log.map(e => `<div class="log-entry important">${esc(e)}</div>`).join('');

  const isHost = S.isHost || state.players[0]?.id === S.playerId;
  qs('#btn-next-round').style.display = isHost ? 'block' : 'none';
  qs('#re-waiting').style.display = isHost ? 'none' : 'block';
}

// ── LOG ──────────────────────────────────────────────────────────────────────
function renderLog(state) {
  const log = qs('#game-log');
  if (!log) return;
  log.innerHTML = (state.log || []).map(e =>
    `<div class="log-entry${e.includes('eliminated')||e.includes('wins')||e.includes('🏆')?' important':e.startsWith('💬')?' chat':''}">${esc(e)}</div>`
  ).join('');
}

function appendLog(msg) {
  const log = qs('#game-log');
  if (!log) return;
  const div = document.createElement('div');
  div.className = 'log-entry';
  div.textContent = msg;
  log.prepend(div);
}

function appendChatLog(entry) {
  // Add to drawer
  const msgs = qs('#chat-messages');
  const div = document.createElement('div');
  div.className = 'chat-msg';
  div.innerHTML = `<span class="chat-who">${esc(entry.name)}:</span><span class="chat-text">${esc(entry.message)}</span>`;
  msgs.appendChild(div);
  msgs.scrollTop = msgs.scrollHeight;

  // Also show briefly in game log
  const log = qs('#game-log');
  const logDiv = document.createElement('div');
  logDiv.className = 'log-entry chat';
  logDiv.textContent = `💬 ${entry.name}: ${entry.message}`;
  log.prepend(logDiv);

  // Badge if drawer closed
  const drawer = qs('#chat-drawer');
  if (!drawer.classList.contains('open')) {
    chatUnread++;
    updateChatBadge();
  }

  if (S.state) { S.state.chat = S.state.chat || []; S.state.chat.push(entry); }
}

function openChat() {
  qs('#chat-drawer').classList.add('open');
  qs('#chat-backdrop').classList.add('open');
  chatUnread = 0;
  updateChatBadge();
  setTimeout(() => {
    const msgs = qs('#chat-messages');
    msgs.scrollTop = msgs.scrollHeight;
    qs('#chat-input').focus();
  }, 50);
}

function closeChat() {
  qs('#chat-drawer').classList.remove('open');
  qs('#chat-backdrop').classList.remove('open');
}

function updateChatBadge() {
  let badge = qs('.chat-badge');
  if (chatUnread > 0) {
    if (!badge) {
      badge = document.createElement('span');
      badge.className = 'chat-badge';
      qs('#btn-chat-fab').appendChild(badge);
    }
    badge.textContent = chatUnread;
  } else if (badge) {
    badge.remove();
  }
}

// ── MODALS ───────────────────────────────────────────────────────────────────
function showNotice(msg, isPersonal = false) {
  // Add to game log
  const log = qs('#game-log');
  const div = document.createElement('div');
  div.className = `log-entry${isPersonal ? ' important' : ''}`;
  div.textContent = msg;
  log.prepend(div);

  // Toast popup
  const toast = document.createElement('div');
  toast.className = `notice-toast${isPersonal ? ' notice-personal' : ''}`;
  toast.textContent = msg;
  document.body.appendChild(toast);
  setTimeout(() => toast.classList.add('notice-show'), 10);
  setTimeout(() => {
    toast.classList.remove('notice-show');
    setTimeout(() => toast.remove(), 400);
  }, 3500);
}

function showBardModal(data) {
  const cardList = data.cards.map(c => `<strong>${c.art} ${c.name} (${c.value})</strong>`).join(', ');
  showModal('🏹 Bard the Bowman — Secret Peek',
    `<strong>${esc(data.targetName)}</strong> holds: ${cardList}<br><br><em>Only you can see this!</em>`,
    `<button class="modal-btn" data-action="close-modal">Got it</button>`
  );
}

function showSmaugModal(data) {
  const hitLine = data.hit
    ? `<strong style="color:#e07070">${esc(data.targetName)} is eliminated!</strong>`
    : `<strong style="color:var(--gold2)">Wrong — no effect.</strong>`;
  showModal('🐉 Smaug — Result',
    `${esc(data.actorName)} named <strong>${esc(data.guessedCard)}</strong> for ${esc(data.targetName)}.<br><br>${hitLine}`,
    `<button class="modal-btn" data-action="close-modal">Continue</button>`
  );
}

function showCompareModal(data) {
  const rule = data.rule;
  const loserLine = data.loser
    ? `<strong style="color:#e07070">${esc(data.loser)} is eliminated!</strong>`
    : `<strong style="color:var(--gold2)">Tied — no elimination!</strong>`;
  showModal(`${data.art} ${data.cardName}`,
    `${esc(data.actorName)}: <strong>${data.actorCard} (${data.actorVal})</strong><br>
    ${esc(data.targetName)}: <strong>${data.targetCard} (${data.targetVal})</strong><br><br>
    <em>${rule}</em><br><br>${loserLine}`,
    `<button class="modal-btn" data-action="close-modal">Continue</button>`
  );
}

function showModal(title, body, btnsHtml) {
  qs('#modal-title').innerHTML = title;
  qs('#modal-body').innerHTML = body;
  qs('#modal-btns').innerHTML = btnsHtml;
  qs('#modal-overlay').style.display = 'flex';
}
function closeModal() { qs('#modal-overlay').style.display = 'none'; }
function closeGuide() { qs('#guide-overlay').style.display = 'none'; }

// Keep as globals for the guide close button in index.html
window.closeModal = closeModal;
window.closeGuide = closeGuide;

// Event delegation for modal close buttons (data-action="close-modal")
document.addEventListener('click', e => {
  if (e.target.closest('[data-action="close-modal"]')) closeModal();
});

// ── CARD GUIDE ───────────────────────────────────────────────────────────────
function renderGuideCards() {
  const cont = qs('#guide-cards');
  CARD_DEFS.forEach(c => {
    const div = document.createElement('div');
    div.className = 'guide-card';
    div.innerHTML = `<div class="guide-art">${renderArt(c.art, 32)}</div>
      <div class="guide-info">
        <div class="gname">${c.name}</div>
        <div class="gval">Value: ${c.value}${c.id==='ring'?' (→7 at round end)':''}</div>
        <div class="geff">${c.effect}</div>
      </div>`;
    cont.appendChild(div);
  });
}

// ── SCREENS ──────────────────────────────────────────────────────────────────
function showReconnectBanner(show) {
  let banner = document.getElementById('reconnect-banner');
  if (!banner) {
    banner = document.createElement('div');
    banner.id = 'reconnect-banner';
    banner.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:500;background:#7a1515;color:#fdf0f0;text-align:center;padding:10px 16px;font-size:13px;display:none;';
    banner.textContent = '⚠ Connection lost — reconnecting… (your spot is held for 24 hours)';
    document.body.appendChild(banner);
  }
  banner.style.display = show ? 'block' : 'none';
}

function quitGame() {
  clearSession();
  S.playerId = null; S.roomCode = null; S.state = null;
  S.selectedCard = null; S.isHost = false;
  S.socket.emit('quit');
  closeChat(); closeLog();
  showScreen('lobby');
}
function openLog() {
  qs('#log-drawer').classList.add('open');
  qs('#log-backdrop').classList.add('open');
}
function closeLog() {
  qs('#log-drawer').classList.remove('open');
  qs('#log-backdrop').classList.remove('open');
}
function showScreen(name) {
  S.phase = name;
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  const target = qs(`#screen-${name}`);
  if (target) target.classList.add('active');
  const fab = qs('#btn-chat-fab');
  if (fab) fab.classList.toggle('visible', name === 'game');
  const logFab = qs('#btn-log-fab');
  if (logFab) logFab.classList.toggle('visible', name === 'game');
  const guideFab = qs('#btn-guide-fab');
  if (guideFab) guideFab.classList.toggle('visible', name === 'game');
}

// ── HELPERS ──────────────────────────────────────────────────────────────────
function qs(sel) { return document.querySelector(sel); }
function renderArt(art, size=20) {
  if (art !== 'PIPE_SVG') return art;
  const s = size;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 36 36" width="${s}" height="${s}" style="vertical-align:middle"><rect x="18" y="16" width="10" height="12" rx="3" fill="#8B4513" stroke="#5C2E00" stroke-width="1.2"/><rect x="4" y="23" width="16" height="4" rx="2" fill="#8B4513" stroke="#5C2E00" stroke-width="1.2"/><ellipse cx="4" cy="25" rx="2" ry="2.5" fill="#6B3410"/><ellipse cx="23" cy="11" rx="4" ry="2.5" fill="none" stroke="#aaa" stroke-width="1.2" opacity="0.8"/><ellipse cx="21" cy="6" rx="3" ry="1.8" fill="none" stroke="#aaa" stroke-width="1" opacity="0.5"/><ellipse cx="24" cy="2" rx="2" ry="1.2" fill="none" stroke="#aaa" stroke-width="0.8" opacity="0.3"/></svg>`;
}
function esc(str) { return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
function showError(msg) { qs('#lobby-error').textContent = msg; }

// closeModal and closeGuide still called from modal HTML buttons
// submitPlay and smaugPickTarget are now called via event delegation only
