/**
 * Universal Game Server v2 with Room Listing
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
    
    // NEW: Room listing features
    this.isPublic = true;
    this.hostName = '';
    this.roomName = '';
  }
  
  addPlayer(ws, playerId, playerName = '') {
    if (this.players.size >= this.maxPlayers) {
      ws.send(JSON.stringify({
        type: 'error',
        message: 'Room is full'
      }));
      return null;
    }
    
    const playerNumber = this.players.size + 1;
    
    this.players.set(playerId, {
      ws,
      playerNumber,
      playerName: playerName || `Player ${playerNumber}`,
      joinedAt: Date.now()
    });
    
    // First player is host
    if (playerNumber === 1) {
      this.hostName = playerName || `Player 1`;
    }
    
    this.lastActivity = Date.now();
    
    console.log(`✅ Player ${playerId} (${playerName}) joined room ${this.roomId}`);
    
    // Send player assignment
    ws.send(JSON.stringify({
      type: 'playerAssigned',
      playerId,
      playerNumber,
      roomId: this.roomId,
      gameType: this.gameType
    }));
    
    // Broadcast room update
    this.broadcastRoomUpdate();
    
    // Broadcast room list update to all clients
    broadcastRoomList();
    
    // Auto-start if room is full
    if (this.players.size === this.maxPlayers && !this.isStarted) {
      setTimeout(() => this.startGame(), 500);
    }
    
    return playerNumber;
  }
  
  removePlayer(playerId) {
    this.players.delete(playerId);
    console.log(`❌ Player ${playerId} left room ${this.roomId}`);
    
    // Broadcast player left
    this.broadcast({
      type: 'playerLeft',
      playerId
    });
    
    this.broadcastRoomUpdate();
    broadcastRoomList();
    
    // Abort game if started
    if (this.isStarted && this.players.size < 2) {
      this.isStarted = false;
      this.broadcast({
        type: 'gameAborted',
        reason: 'Player disconnected'
      });
    }
    
    // Return true if room is empty (should be deleted)
    return this.players.size === 0;
  }
  
  startGame() {
    if (this.isStarted) return;
    
    this.isStarted = true;
    this.lastActivity = Date.now();
    
    console.log(`🎮 Game started in room ${this.roomId}`);
    
    this.broadcast({
      type: 'gameStart',
      players: Array.from(this.players.entries()).map(([id, p]) => ({
        playerId: id,
        playerNumber: p.playerNumber,
        playerName: p.playerName
      }))
    });
    
    broadcastRoomList();
  }
  
  broadcastRoomUpdate() {
    const playersList = Array.from(this.players.entries()).map(([id, p]) => ({
      playerId: id,
      playerNumber: p.playerNumber,
      playerName: p.playerName
    }));
    
    this.broadcast({
      type: 'roomUpdate',
      roomId: this.roomId,
      players: playersList,
      playersCount: this.players.size,
      maxPlayers: this.maxPlayers,
      isStarted: this.isStarted,
      canStart: this.players.size >= 2
    });
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
    
    // Handle different message types
    if (data.type === 'startGame') {
      this.startGame();
    } 
    else if (data.type === 'gameAction') {
      // Relay game actions to other players
      this.broadcast(data, playerId);
    }
    else if (data.type === 'paddleMove' || data.type === 'puckSync' || data.type === 'score') {
      // Air hockey specific messages
      this.broadcast(data, playerId);
    }
    else {
      // Generic message relay
      this.broadcast(data, playerId);
    }
  }
}

// ============================================
// REST API - Room Listing
// ============================================

// Get room list
app.get('/api/rooms', (req, res) => {
  const gameType = req.query.gameType;
  
  const publicRooms = Array.from(rooms.values())
    .filter(room => room.isPublic)
    .filter(room => !gameType || room.gameType === gameType)
    .map(room => ({
      roomId: room.roomId,
      gameType: room.gameType,
      roomName: room.roomName || room.roomId,
      hostName: room.hostName,
      players: room.players.size,
      maxPlayers: room.maxPlayers,
      status: room.isStarted ? 'playing' : 'waiting',
      createdAt: room.createdAt
    }))
    .sort((a, b) => b.createdAt - a.createdAt); // Newest first
  
  res.json({ rooms: publicRooms });
});

// Stats API
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
// WebSocket Server
// ============================================

const server = app.listen(PORT, () => {
  console.log(`🚀 Universal Game Server v2 running on port ${PORT}`);
});

const wss = new WebSocket.Server({ server });

// Broadcast room list to all connected clients
function broadcastRoomList() {
  const publicRooms = Array.from(rooms.values())
    .filter(room => room.isPublic)
    .map(room => ({
      roomId: room.roomId,
      gameType: room.gameType,
      roomName: room.roomName || room.roomId,
      hostName: room.hostName,
      players: room.players.size,
      maxPlayers: room.maxPlayers,
      status: room.isStarted ? 'playing' : 'waiting'
    }));
  
  const message = JSON.stringify({
    type: 'roomListUpdate',
    rooms: publicRooms
  });
  
  // Send to all connected clients
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(message);
    }
  });
}

wss.on('connection', (ws, req) => {
  const url = new URL(req.url, `ws://${req.headers.host}`);
  const roomParam = url.searchParams.get('room');
  
  console.log(`🔌 New connection (room param: ${roomParam})`);
  
  let currentRoom = null;
  let currentPlayerId = null;
  
  ws.on('message', (message) => {
    try {
      const data = JSON.parse(message.toString());
      console.log(`📩 Received:`, data.type, data);
      
      // Handle join message
      if (data.type === 'join') {
        const { roomId, playerId, playerName, gameType, isPublic, roomName } = data;
        currentPlayerId = playerId;
        
        // Create room if doesn't exist
        if (!rooms.has(roomId)) {
          const room = new GameRoom(
            roomId, 
            gameType || 'default',
            data.maxPlayers || 2
          );
          room.isPublic = isPublic !== false; // Default true
          room.roomName = roomName || roomId;
          rooms.set(roomId, room);
          console.log(`🆕 Room created: ${roomId} (${gameType})`);
        }
        
        currentRoom = rooms.get(roomId);
        currentRoom.addPlayer(ws, playerId, playerName);
      }
      // Handle other messages
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

// Cleanup old rooms (every 5 minutes)
setInterval(() => {
  const now = Date.now();
  const TIMEOUT = 30 * 60 * 1000; // 30 minutes
  
  rooms.forEach((room, roomId) => {
    if (now - room.lastActivity > TIMEOUT && room.players.size === 0) {
      rooms.delete(roomId);
      console.log(`🗑️ Room ${roomId} cleaned up (inactive)`);
    }
  });
}, 5 * 60 * 1000);

// Home page
app.get('/', (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html>
    <head>
      <title>Universal Game Server v2</title>
      <style>
        body { 
          font-family: 'Segoe UI', Arial; 
          background: linear-gradient(135deg, #0f2027, #203a43, #2c5364);
          color: #fff; 
          padding: 40px;
          margin: 0;
        }
        h1 { color: #00f3ff; text-shadow: 0 0 10px rgba(0,243,255,0.5); }
        .container { max-width: 1200px; margin: 0 auto; }
        .stats { display: flex; gap: 20px; margin: 30px 0; }
        .stat { 
          flex: 1; 
          background: rgba(0,0,0,0.3); 
          padding: 30px; 
          border-radius: 12px;
          text-align: center;
          border: 1px solid rgba(255,255,255,0.1);
        }
        .stat-value { 
          font-size: 56px; 
          font-weight: bold; 
          color: #00f3ff; 
          text-shadow: 0 0 20px rgba(0,243,255,0.6);
        }
        .stat-label { 
          font-size: 14px; 
          color: #aaa; 
          margin-top: 10px;
        }
        .section {
          background: rgba(0,0,0,0.3);
          padding: 30px;
          margin: 20px 0;
          border-radius: 12px;
          border: 1px solid rgba(255,255,255,0.1);
        }
        .section h2 { color: #00f3ff; margin-top: 0; }
        code { 
          background: rgba(0,0,0,0.5); 
          padding: 4px 8px; 
          border-radius: 4px;
          color: #0ff;
        }
        .rooms-list {
          margin-top: 20px;
        }
        .room-item {
          background: rgba(0,243,255,0.05);
          padding: 15px;
          margin: 10px 0;
          border-radius: 8px;
          border-left: 3px solid #00f3ff;
        }
      </style>
    </head>
    <body>
      <div class="container">
        <h1>🎮 Universal Game Server v2</h1>
        <p>Multi-game support with room listing</p>
        
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
          <h2>📋 Public Rooms</h2>
          <div id="rooms-list" class="rooms-list">
            <p style="color: #888;">No public rooms available</p>
          </div>
        </div>
        
        <div class="section">
          <h2>🔌 API Endpoints</h2>
          <p><strong>WebSocket:</strong> <code>wss://YOUR-SERVER.com?room=ROOM_ID</code></p>
          <p><strong>Room List:</strong> <code>GET /api/rooms</code></p>
          <p><strong>Filter by game:</strong> <code>GET /api/rooms?gameType=air-hockey</code></p>
          <p><strong>Stats:</strong> <code>GET /api/stats</code></p>
        </div>
        
        <div class="section">
          <h2>📝 Supported Games</h2>
          <ul>
            <li>🏒 Air Hockey</li>
            <li>🃏 Memory Game (coming soon)</li>
            <li>⚫ Reversi (coming soon)</li>
            <li>🎮 Your game here!</li>
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
        
        function updateRoomList() {
          fetch('/api/rooms')
            .then(r => r.json())
            .then(data => {
              const container = document.getElementById('rooms-list');
              if (data.rooms.length === 0) {
                container.innerHTML = '<p style="color: #888;">No public rooms available</p>';
              } else {
                container.innerHTML = data.rooms.map(room => \`
                  <div class="room-item">
                    <strong>\${room.roomName}</strong> 
                    <span style="color: #00f3ff;">(\${room.gameType})</span>
                    <br>
                    <small style="color: #aaa;">
                      Host: \${room.hostName} | 
                      Players: \${room.players}/\${room.maxPlayers} | 
                      Status: \${room.status}
                    </small>
                  </div>
                \`).join('');
              }
            });
        }
        
        updateStats();
        updateRoomList();
        setInterval(updateStats, 2000);
        setInterval(updateRoomList, 3000);
      </script>
    </body>
    </html>
  `);
});

console.log(`
╔════════════════════════════════════════╗
║  🎮 UNIVERSAL GAME SERVER V2 READY   ║
║  📋 Room Listing: Enabled             ║
║  🔄 Auto-refresh: Enabled             ║
╚════════════════════════════════════════╝
`);
