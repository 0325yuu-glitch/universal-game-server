/**
 * Universal Game Server v3 with Daifugo Support
 * Supports multiple game types with public/private rooms
 */

const express = require('express');
const WebSocket = require('ws');

const app = express();
const PORT = process.env.PORT || 8080;

// Middleware
app.use(express.json({ limit: '50mb' }));
app.use(express.text({ limit: '50mb' }));

// CORS
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// ============================================
// Game Rooms Storage
// ============================================

const rooms = new Map();

// ============================================
// Daifugo Game Logic
// ============================================

class DaifugoGame {
  constructor(playerCount) {
    this.playerCount = playerCount;
    this.players = [];
    this.hands = [];
    this.field = [];
    this.turn = 0;
    this.passCount = 0;
    this.isRevolution = false;
    this.finished = [];
    this.disqualified = [];
    this.starter = 0;
  }

  init(playerNames) {
    this.players = playerNames;
    
    // Create deck
    const SUITS = ['♠', '♥', '♦', '♣'];
    const RANKS = ['3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A', '2'];
    let deck = [];
    
    SUITS.forEach(s => {
      RANKS.forEach((r, i) => {
        deck.push({ s, r, v: i, id: Math.random().toString(36).substr(2, 9) });
      });
    });
    
    // Add 2 jokers
    deck.push({ s: 'JK', r: 'JK', v: 99, isJ: true, id: 'j1' });
    deck.push({ s: 'JK', r: 'JK', v: 99, isJ: true, id: 'j2' });
    
    // Shuffle
    for (let i = deck.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [deck[i], deck[j]] = [deck[j], deck[i]];
    }
    
    // Deal cards
    this.hands = Array.from({ length: this.playerCount }, () => []);
    deck.forEach((card, i) => {
      this.hands[i % this.playerCount].push(card);
    });
    
    // Sort hands
    this.hands.forEach(hand => this.sortHand(hand));
    
    // Find starter (who has diamond 3)
    for (let i = 0; i < this.playerCount; i++) {
      if (this.hands[i].some(c => c.s === '♦' && c.r === '3')) {
        this.starter = i;
        this.turn = i;
        break;
      }
    }
  }

  sortHand(hand) {
    hand.sort((a, b) => {
      const va = a.isJ ? 999 : (this.isRevolution ? 12 - a.v : a.v);
      const vb = b.isJ ? 999 : (this.isRevolution ? 12 - b.v : b.v);
      return va - vb;
    });
  }

  isValidMove(playerIdx, cards) {
    // Not player's turn
    if (playerIdx !== this.turn) return { valid: false, reason: 'Not your turn' };
    
    // No cards selected
    if (!cards || cards.length === 0) return { valid: false, reason: 'No cards selected' };
    
    // Check if player has these cards
    const hand = this.hands[playerIdx];
    const cardIds = cards.map(c => c.id);
    const hasAll = cardIds.every(id => hand.some(c => c.id === id));
    if (!hasAll) return { valid: false, reason: 'Invalid cards' };
    
    // Check same rank (except jokers)
    const normals = cards.filter(c => !c.isJ);
    if (normals.length > 1) {
      const firstVal = normals[0].v;
      if (!normals.every(c => c.v === firstVal)) {
        return { valid: false, reason: 'Cards must be same rank' };
      }
    }
    
    // If field is empty, any valid combination is OK
    if (this.field.length === 0) return { valid: true };
    
    const lastPlay = this.field[this.field.length - 1].cards;
    
    // Must match count
    if (cards.length !== lastPlay.length) {
      return { valid: false, reason: 'Must play same number of cards' };
    }
    
    // Spade 3 return (only if last play has joker)
    if (cards.length === 1 && cards[0].s === '♠' && cards[0].r === '3') {
      if (lastPlay.length === 1 && lastPlay[0].isJ) {
        return { valid: true };
      }
    }
    
    // Compare strength
    const myStrength = normals.length > 0 
      ? (this.isRevolution ? 12 - normals[0].v : normals[0].v) 
      : 999;
    
    const lastNormals = lastPlay.filter(c => !c.isJ);
    const lastStrength = lastNormals.length > 0 
      ? (this.isRevolution ? 12 - lastNormals[0].v : lastNormals[0].v) 
      : 999;
    
    if (myStrength <= lastStrength) {
      return { valid: false, reason: 'Cards not strong enough' };
    }
    
    return { valid: true };
  }

  playCards(playerIdx, cards) {
    const validation = this.isValidMove(playerIdx, cards);
    if (!validation.valid) return { success: false, reason: validation.reason };
    
    // Remove cards from hand
    const cardIds = cards.map(c => c.id);
    this.hands[playerIdx] = this.hands[playerIdx].filter(c => !cardIds.includes(c.id));
    
    // Add to field
    this.field.push({ cards, owner: playerIdx });
    this.passCount = 0;
    
    let flowField = false;
    let revolution = false;
    let eightCut = false;
    let spade3Return = false;
    
    // Check revolution (4+ cards)
    if (cards.length >= 4) {
      this.isRevolution = !this.isRevolution;
      revolution = true;
      flowField = true;
      
      // Re-sort all hands
      this.hands.forEach(hand => this.sortHand(hand));
    }
    
    // Check 8-cut
    if (cards.some(c => !c.isJ && c.r === '8')) {
      eightCut = true;
      flowField = true;
    }
    
    // Check spade 3 return
    if (cards.length === 1 && cards[0].s === '♠' && cards[0].r === '3') {
      if (this.field.length >= 2 && this.field[this.field.length - 2].cards[0].isJ) {
        spade3Return = true;
        flowField = true;
      }
    }
    
    // Check if player finished
    let finished = false;
    let disqualified = false;
    
    if (this.hands[playerIdx].length === 0) {
      // Check forbidden finish
      const hasForbidden = cards.some(c => {
        if (c.isJ) return true;
        if (!this.isRevolution && c.r === '2') return true;
        if (this.isRevolution && c.r === '3') return true;
        if (!c.isJ && c.r === '8') return true;
        return false;
      });
      
      if (hasForbidden) {
        disqualified = true;
        this.disqualified.push(playerIdx);
      } else {
        finished = true;
        this.finished.push(playerIdx);
      }
    }
    
    // Determine next turn
    let nextTurn = this.turn;
    
    if (flowField) {
      // Field flows, same player continues (unless finished)
      if (!finished && !disqualified) {
        nextTurn = playerIdx;
      } else {
        nextTurn = (playerIdx + 1) % this.playerCount;
      }
    } else {
      // Normal: next player
      nextTurn = (this.turn + 1) % this.playerCount;
    }
    
    // Skip finished/disqualified players
    while (this.finished.includes(nextTurn) || this.disqualified.includes(nextTurn)) {
      nextTurn = (nextTurn + 1) % this.playerCount;
      if (nextTurn === this.turn) break; // Safety check
    }
    
    this.turn = nextTurn;
    
    return {
      success: true,
      revolution,
      eightCut,
      spade3Return,
      flowField,
      finished,
      disqualified,
      nextTurn: this.turn,
      handCount: this.hands[playerIdx].length
    };
  }

  pass(playerIdx) {
    if (playerIdx !== this.turn) return { success: false, reason: 'Not your turn' };
    if (this.field.length === 0) return { success: false, reason: 'Cannot pass on empty field' };
    
    this.passCount++;
    
    const activePlayers = this.playerCount - (this.finished.length + this.disqualified.length);
    const needPasses = activePlayers - 1;
    
    let fieldCleared = false;
    let nextTurn = this.turn;
    
    if (this.passCount >= needPasses) {
      // Field clears
      const lastOwner = this.field[this.field.length - 1].owner;
      fieldCleared = true;
      
      // Next turn is last card player (if still active)
      if (!this.finished.includes(lastOwner) && !this.disqualified.includes(lastOwner)) {
        nextTurn = lastOwner;
      } else {
        nextTurn = (lastOwner + 1) % this.playerCount;
      }
    } else {
      // Normal: next player
      nextTurn = (this.turn + 1) % this.playerCount;
    }
    
    // Skip finished/disqualified players
    while (this.finished.includes(nextTurn) || this.disqualified.includes(nextTurn)) {
      nextTurn = (nextTurn + 1) % this.playerCount;
    }
    
    this.turn = nextTurn;
    
    return {
      success: true,
      fieldCleared,
      nextTurn: this.turn
    };
  }

  clearField() {
    this.field = [];
    this.passCount = 0;
  }

  isGameOver() {
    return (this.finished.length + this.disqualified.length) >= this.playerCount - 1;
  }

  getFinalRankings() {
    const rankings = [...this.finished];
    
    // Add remaining player
    for (let i = 0; i < this.playerCount; i++) {
      if (!this.finished.includes(i) && !this.disqualified.includes(i)) {
        rankings.push(i);
      }
    }
    
    // Add disqualified at end
    rankings.push(...this.disqualified);
    
    return rankings;
  }
}

// ============================================
// Game Room Class
// ============================================

class GameRoom {
  constructor(roomId, gameType = 'default', maxPlayers = 2) {
    this.roomId = roomId;
    this.gameType = gameType;
    this.maxPlayers = maxPlayers;
    this.players = new Map();
    this.gameState = {};
    this.isStarted = false;
    this.createdAt = Date.now();
    this.lastActivity = Date.now();
    
    this.isPublic = true;
    this.hostName = '';
    this.roomName = '';
    this.hostId = null;
    
    // Daifugo specific
    this.daifugoGame = null;
  }
  
  addPlayer(ws, playerId, playerName = '') {
    if (this.players.size >= this.maxPlayers) {
      ws.send(JSON.stringify({
        type: 'error',
        message: 'Room is full'
      }));
      return null;
    }
    
    const playerNumber = this.players.size;
    const isHost = playerNumber === 0;
    
    this.players.set(playerId, {
      ws,
      playerNumber,
      playerName: playerName || `Player ${playerNumber + 1}`,
      joinedAt: Date.now(),
      isHost
    });
    
    if (isHost) {
      this.hostName = playerName || `Player 1`;
      this.hostId = playerId;
    }
    
    this.lastActivity = Date.now();
    
    console.log(`✅ Player ${playerId} (${playerName}) joined room ${this.roomId} as Player ${playerNumber}`);
    
    // Send room created/joined
    ws.send(JSON.stringify({
      type: isHost ? 'roomCreated' : 'roomJoined',
      roomId: this.roomId,
      playerNumber,
      isHost
    }));
    
    // Broadcast player joined
    this.broadcastPlayerList();
    
    // Broadcast room list update
    broadcastRoomList();
    
    return playerNumber;
  }
  
  removePlayer(playerId) {
    const player = this.players.get(playerId);
    if (!player) return false;
    
    this.players.delete(playerId);
    console.log(`❌ Player ${playerId} left room ${this.roomId}`);
    
    // Broadcast player left
    this.broadcast({
      type: 'playerLeft',
      playerId,
      playerName: player.playerName
    });
    
    this.broadcastPlayerList();
    broadcastRoomList();
    
    // Abort game if started
    if (this.isStarted) {
      this.broadcast({
        type: 'gameAborted',
        reason: 'Player disconnected'
      });
      this.isStarted = false;
    }
    
    return this.players.size === 0;
  }
  
  broadcastPlayerList() {
    const playersList = Array.from(this.players.entries()).map(([id, p]) => ({
      id,
      name: p.playerName,
      isHost: p.isHost
    }));
    
    this.broadcast({
      type: 'playerJoined',
      roomId: this.roomId,
      players: playersList,
      currentCount: this.players.size,
      maxPlayers: this.maxPlayers
    });
  }
  
  startGame() {
    if (this.isStarted) return;
    if (this.players.size < 2) {
      return { success: false, reason: 'Need at least 2 players' };
    }
    
    this.isStarted = true;
    this.lastActivity = Date.now();
    
    console.log(`🎮 Game started in room ${this.roomId}`);
    
    // Initialize Daifugo game
    const playerNames = Array.from(this.players.values()).map(p => p.playerName);
    this.daifugoGame = new DaifugoGame(this.players.size);
    this.daifugoGame.init(playerNames);
    
    // Send game start to each player with their hand
    const playersArray = Array.from(this.players.entries());
    playersArray.forEach(([playerId, player], idx) => {
      player.ws.send(JSON.stringify({
        type: 'gameStart',
        roomId: this.roomId,
        playerNumber: idx,
        playerNames,
        hand: this.daifugoGame.hands[idx],
        starter: this.daifugoGame.starter
      }));
    });
    
    // Broadcast turn start
    this.broadcast({
      type: 'turnStart',
      currentPlayer: this.daifugoGame.turn
    });
    
    broadcastRoomList();
    
    return { success: true };
  }
  
  broadcast(message, excludePlayerId = null) {
    this.players.forEach((player, playerId) => {
      if (playerId !== excludePlayerId && player.ws.readyState === WebSocket.OPEN) {
        player.ws.send(JSON.stringify(message));
      }
    });
  }
  
  handleMessage(playerId, data) {
    this.lastActivity = Date.now();
    const player = this.players.get(playerId);
    if (!player) return;
    
    // Handle start game (host only)
    if (data.type === 'startGame') {
      if (!player.isHost) {
        player.ws.send(JSON.stringify({
          type: 'error',
          message: 'Only host can start game'
        }));
        return;
      }
      
      const result = this.startGame();
      if (!result.success) {
        player.ws.send(JSON.stringify({
          type: 'error',
          message: result.reason
        }));
      }
      return;
    }
    
    // Game must be started for these actions
    if (!this.isStarted || !this.daifugoGame) return;
    
    // Handle play cards
    if (data.type === 'playCards') {
      const result = this.daifugoGame.playCards(player.playerNumber, data.cards);
      
      if (!result.success) {
        player.ws.send(JSON.stringify({
          type: 'error',
          message: result.reason
        }));
        return;
      }
      
      // Broadcast cards played
      this.broadcast({
        type: 'cardsPlayed',
        player: player.playerNumber,
        cards: data.cards,
        revolution: result.revolution,
        eightCut: result.eightCut,
        spade3Return: result.spade3Return
      });
      
      // If field flows, clear it
      if (result.flowField) {
        setTimeout(() => {
          this.daifugoGame.clearField();
          this.broadcast({
            type: 'fieldCleared',
            nextPlayer: result.nextTurn
          });
          
          this.broadcast({
            type: 'turnStart',
            currentPlayer: result.nextTurn
          });
        }, 1500);
      } else {
        // Send turn start
        this.broadcast({
          type: 'turnStart',
          currentPlayer: result.nextTurn
        });
      }
      
      // If player finished
      if (result.finished || result.disqualified) {
        this.broadcast({
          type: 'playerFinished',
          player: player.playerNumber,
          rank: this.daifugoGame.finished.length,
          disqualified: result.disqualified
        });
        
        // Check game over
        if (this.daifugoGame.isGameOver()) {
          setTimeout(() => {
            const rankings = this.daifugoGame.getFinalRankings();
            this.broadcast({
              type: 'gameOver',
              rankings,
              disqualified: this.daifugoGame.disqualified
            });
            
            this.isStarted = false;
          }, 2000);
        }
      }
    }
    
    // Handle pass
    else if (data.type === 'pass') {
      const result = this.daifugoGame.pass(player.playerNumber);
      
      if (!result.success) {
        player.ws.send(JSON.stringify({
          type: 'error',
          message: result.reason
        }));
        return;
      }
      
      // Broadcast pass
      this.broadcast({
        type: 'playerPassed',
        player: player.playerNumber
      });
      
      // If field cleared
      if (result.fieldCleared) {
        setTimeout(() => {
          this.daifugoGame.clearField();
          this.broadcast({
            type: 'fieldCleared',
            nextPlayer: result.nextTurn
          });
          
          this.broadcast({
            type: 'turnStart',
            currentPlayer: result.nextTurn
          });
        }, 800);
      } else {
        // Send turn start
        this.broadcast({
          type: 'turnStart',
          currentPlayer: result.nextTurn
        });
      }
    }
    
    // Legacy: relay other game messages (air hockey, etc.)
    else if (data.type === 'paddleMove' || data.type === 'puckSync' || data.type === 'score') {
      this.broadcast(data, playerId);
    }
  }
}

// ============================================
// REST API
// ============================================

app.get('/api/rooms', (req, res) => {
  const gameType = req.query.gameType;
  
  const publicRooms = Array.from(rooms.values())
    .filter(room => room.isPublic)
    .filter(room => !gameType || room.gameType === gameType)
    .filter(room => !room.isStarted) // Only show waiting rooms
    .map(room => ({
      roomId: room.roomId,
      gameType: room.gameType,
      roomName: room.roomName || room.roomId,
      hostName: room.hostName,
      players: room.players.size,
      maxPlayers: room.maxPlayers,
      status: 'waiting',
      createdAt: room.createdAt
    }))
    .sort((a, b) => b.createdAt - a.createdAt);
  
  res.json({ rooms: publicRooms });
});

app.get('/api/stats', (req, res) => {
  let totalPlayers = 0;
  let gamesInProgress = 0;
  
  rooms.forEach(room => {
    totalPlayers += room.players.size;
    if (room.isStarted) gamesInProgress++;
  });
  
  res.json({
    rooms: rooms.size,
    players: totalPlayers,
    games: gamesInProgress
  });
});

// ============================================
// HTML Code Storage API
// ============================================

const codes = new Map();

// コードを保存
app.post('/api/code/save', express.text({limit: '10mb'}), (req, res) => {
    const id = Math.random().toString(36).substr(2, 9);
    codes.set(id, req.body);
    
    const url = `${req.protocol}://${req.get('host')}/api/code/${id}`;
    
    console.log(`💾 Code saved with ID: ${id}`);
    
    res.json({ 
        id, 
        url,
        length: req.body.length
    });
});

// コードを取得（プレーンテキストで返す）
app.get('/api/code/:id', (req, res) => {
    const code = codes.get(req.params.id);
    
    if (!code) {
        return res.status(404).send('Code not found');
    }
    
    console.log(`📤 Code retrieved: ${req.params.id}`);
    
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.send(code);
});

// コード一覧を取得（デバッグ用）
app.get('/api/codes', (req, res) => {
    const codeList = Array.from(codes.entries()).map(([id, code]) => ({
        id,
        length: code.length,
        preview: code.substring(0, 100) + '...'
    }));
    
    res.json({ 
        count: codes.size,
        codes: codeList 
    });
});

// ============================================
// WebSocket Server
// ============================================

const server = app.listen(PORT, () => {
  console.log(`🚀 Universal Game Server v3 (Daifugo) running on port ${PORT}`);
});

const wss = new WebSocket.Server({ server });

function broadcastRoomList() {
  const publicRooms = Array.from(rooms.values())
    .filter(room => room.isPublic && !room.isStarted)
    .map(room => ({
      roomId: room.roomId,
      gameType: room.gameType,
      roomName: room.roomName || room.roomId,
      hostName: room.hostName,
      players: room.players.size,
      maxPlayers: room.maxPlayers,
      status: 'waiting'
    }));
  
  const message = JSON.stringify({
    type: 'roomListUpdate',
    rooms: publicRooms
  });
  
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(message);
    }
  });
}

wss.on('connection', (ws, req) => {
  console.log(`🔌 New connection`);
  
  let currentRoom = null;
  let currentPlayerId = null;
  
  ws.on('message', (message) => {
    try {
      const data = JSON.parse(message.toString());
      console.log(`📩 Received:`, data.type);
      
      if (data.type === 'createRoom') {
        const roomId = 'room_' + Math.random().toString(36).substr(2, 9);
        currentPlayerId = 'p_' + Math.random().toString(36).substr(2, 9);
        
        const room = new GameRoom(
          roomId,
          data.gameType || 'daifugo',
          data.maxPlayers || 4
        );
        room.isPublic = data.isPublic !== false;
        room.roomName = data.roomName || roomId;
        
        rooms.set(roomId, room);
        currentRoom = room;
        
        currentRoom.addPlayer(ws, currentPlayerId, data.playerName);
        
        console.log(`🆕 Room created: ${roomId}`);
      }
      else if (data.type === 'joinRoom') {
        currentPlayerId = 'p_' + Math.random().toString(36).substr(2, 9);
        
        if (!rooms.has(data.roomId)) {
          ws.send(JSON.stringify({
            type: 'error',
            message: 'Room not found'
          }));
          return;
        }
        
        currentRoom = rooms.get(data.roomId);
        currentRoom.addPlayer(ws, currentPlayerId, data.playerName);
      }
      else if (currentRoom) {
        currentRoom.handleMessage(currentPlayerId, data);
      }
      
    } catch (err) {
      console.error('❌ Message error:', err);
      ws.send(JSON.stringify({
        type: 'error',
        message: err.message
      }));
    }
  });
  
  ws.on('close', () => {
    console.log('👋 Connection closed');
    if (currentRoom && currentPlayerId) {
      const isEmpty = currentRoom.removePlayer(currentPlayerId);
      if (isEmpty) {
        rooms.delete(currentRoom.roomId);
        console.log(`🗑️ Room deleted: ${currentRoom.roomId}`);
        broadcastRoomList();
      }
    }
  });
  
  ws.on('error', (err) => {
    console.error('❌ WebSocket error:', err);
  });
});

// Cleanup
setInterval(() => {
  const now = Date.now();
  const TIMEOUT = 30 * 60 * 1000;
  
  rooms.forEach((room, roomId) => {
    if (now - room.lastActivity > TIMEOUT && room.players.size === 0) {
      rooms.delete(roomId);
      console.log(`🗑️ Room ${roomId} cleaned up`);
    }
  });
}, 5 * 60 * 1000);

// Home page
app.get('/', (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html>
    <head>
      <title>Universal Game Server v3</title>
      <style>
        body { 
          font-family: 'Segoe UI', Arial; 
          background: linear-gradient(135deg, #1e4d3b, #27634c);
          color: #fff; 
          padding: 40px;
          margin: 0;
        }
        h1 { color: gold; text-shadow: 0 0 10px rgba(255,215,0,0.5); }
        .container { max-width: 1200px; margin: 0 auto; }
        .stats { display: flex; gap: 20px; margin: 30px 0; }
        .stat { 
          flex: 1; 
          background: rgba(0,0,0,0.3); 
          padding: 30px; 
          border-radius: 12px;
          text-align: center;
        }
        .stat-value { font-size: 56px; font-weight: bold; color: gold; }
        .stat-label { font-size: 14px; color: #aaa; margin-top: 10px; }
        .section { background: rgba(0,0,0,0.3); padding: 30px; margin: 20px 0; border-radius: 12px; }
        .section h2 { color: gold; margin-top: 0; }
      </style>
    </head>
    <body>
      <div class="container">
        <h1>🎴 Universal Game Server v3 - Daifugo</h1>
        
        <div class="stats">
          <div class="stat">
            <div class="stat-value" id="rooms">0</div>
            <div class="stat-label">Active Rooms</div>
          </div>
          <div class="stat">
            <div class="stat-value" id="players">0</div>
            <div class="stat-label">Online Players</div>
          </div>
          <div class="stat">
            <div class="stat-value" id="games">0</div>
            <div class="stat-label">Games in Progress</div>
          </div>
        </div>
        
        <div class="section">
          <h2>🎮 Supported Games</h2>
          <ul>
            <li>🎴 大富豪 (Daifugo)</li>
            <li>🏒 Air Hockey</li>
          </ul>
        </div>
      </div>
      
      <script>
        function updateStats() {
          fetch('/api/stats')
            .then(r => r.json())
            .then(data => {
              document.getElementById('rooms').textContent = data.rooms;
              document.getElementById('players').textContent = data.players;
              document.getElementById('games').textContent = data.games;
            });
        }
        updateStats();
        setInterval(updateStats, 3000);
      </script>
    </body>
    </html>
  `);
});

console.log(`
╔════════════════════════════════════════╗
║  🎴 DAIFUGO SERVER READY              ║
║  ✅ 2-4 Players Support               ║
║  ✅ Full Rule Implementation          ║
╚════════════════════════════════════════╝
`);
