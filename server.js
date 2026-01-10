// ========================================
// 汎用ゲームサーバー - Universal Game Platform
// どんなマルチプレイゲームでも対応
// ========================================

const express = require('express');
const { WebSocketServer } = require('ws');
const http = require('http');
const crypto = require('crypto');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

// ========================================
// データ構造
// ========================================

// ゲームルーム管理
class GameRoom {
  constructor(roomId, gameType, maxPlayers = 4) {
    this.roomId = roomId;
    this.gameType = gameType; // 'air-hockey', 'card-game', 'rpg', etc.
    this.maxPlayers = maxPlayers;
    this.players = new Map(); // playerId -> { ws, playerNumber, name, data }
    this.gameState = {}; // ゲーム固有の状態
    this.isStarted = false;
    this.createdAt = new Date();
    this.lastActivity = new Date();
    this.metadata = {}; // ゲーム固有のメタデータ
  }

  addPlayer(ws, playerId, playerName = null) {
    if (this.players.size >= this.maxPlayers) {
      return { success: false, error: 'Room is full' };
    }

    const playerNumber = this.players.size + 1;
    
    this.players.set(playerId, {
      ws: ws,
      playerNumber: playerNumber,
      name: playerName || `Player ${playerNumber}`,
      data: {},
      joinedAt: new Date()
    });

    this.lastActivity = new Date();

    // プレイヤーに情報を通知
    this.send(ws, {
      type: 'playerAssigned',
      playerId: playerId,
      playerNumber: playerNumber,
      roomId: this.roomId,
      gameType: this.gameType
    });

    // 全員にルーム状態を通知
    this.broadcast({
      type: 'roomUpdate',
      roomId: this.roomId,
      players: Array.from(this.players.values()).map(p => ({
        playerNumber: p.playerNumber,
        name: p.name,
        data: p.data
      })),
      playersCount: this.players.size,
      maxPlayers: this.maxPlayers,
      isStarted: this.isStarted,
      canStart: this.players.size >= 2
    });

    console.log(`✅ Player ${playerId} joined room ${this.roomId} (${this.players.size}/${this.maxPlayers})`);

    return { success: true, playerNumber: playerNumber };
  }

  removePlayer(playerId) {
    const player = this.players.get(playerId);
    if (!player) return;

    this.players.delete(playerId);
    this.lastActivity = new Date();

    // 残りのプレイヤーに通知
    this.broadcast({
      type: 'playerLeft',
      playerId: playerId,
      playersCount: this.players.size
    });

    console.log(`❌ Player ${playerId} left room ${this.roomId}`);

    // ゲーム中に誰かが抜けたらゲームをリセット
    if (this.isStarted && this.players.size < 2) {
      this.isStarted = false;
      this.broadcast({
        type: 'gameAborted',
        reason: 'Not enough players'
      });
    }
  }

  handleMessage(playerId, data) {
    const player = this.players.get(playerId);
    if (!player) return;

    this.lastActivity = new Date();

    switch (data.type) {
      case 'startGame':
        this.startGame(playerId);
        break;

      case 'gameAction':
        this.handleGameAction(playerId, data.action);
        break;

      case 'updateState':
        this.updateGameState(playerId, data.state);
        break;

      case 'chat':
        this.handleChat(playerId, data.message);
        break;

      case 'updatePlayerData':
        this.updatePlayerData(playerId, data.data);
        break;

      default:
        // ゲーム固有のメッセージをそのままブロードキャスト
        this.broadcast({
          ...data,
          fromPlayer: playerId
        }, playerId);
    }
  }

  startGame(initiatorId) {
    if (this.players.size < 2) {
      this.send(this.players.get(initiatorId).ws, {
        type: 'error',
        message: 'Need at least 2 players to start'
      });
      return;
    }

    if (this.isStarted) {
      return;
    }

    this.isStarted = true;
    this.gameState = this.initializeGameState();

    this.broadcast({
      type: 'gameStart',
      roomId: this.roomId,
      gameType: this.gameType,
      players: Array.from(this.players.values()).map(p => ({
        playerNumber: p.playerNumber,
        name: p.name,
        data: p.data
      })),
      initialState: this.gameState
    });

    console.log(`🎮 Game started in room ${this.roomId} (${this.gameType})`);
  }

  initializeGameState() {
    // ゲームタイプに応じた初期状態
    switch (this.gameType) {
      case 'air-hockey':
        return {
          puck: { x: 400, y: 300, vx: 0, vy: 0 },
          scores: Array(this.players.size).fill(0)
        };
      
      case 'card-game':
        return {
          deck: this.shuffleDeck(),
          hands: {},
          currentTurn: 1
        };
      
      default:
        return {};
    }
  }

  shuffleDeck() {
    // カードゲーム用のデッキシャッフル
    const deck = [];
    const suits = ['♠', '♥', '♦', '♣'];
    const ranks = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];
    
    for (const suit of suits) {
      for (const rank of ranks) {
        deck.push({ suit, rank });
      }
    }
    
    // Fisher-Yates シャッフル
    for (let i = deck.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [deck[i], deck[j]] = [deck[j], deck[i]];
    }
    
    return deck;
  }

  handleGameAction(playerId, action) {
    // ゲーム固有のアクション処理
    this.broadcast({
      type: 'gameAction',
      playerId: playerId,
      action: action,
      timestamp: Date.now()
    }, playerId);
  }

  updateGameState(playerId, stateUpdate) {
    // 状態更新をマージ
    this.gameState = {
      ...this.gameState,
      ...stateUpdate
    };

    // 他のプレイヤーに同期
    this.broadcast({
      type: 'stateSync',
      state: this.gameState,
      updatedBy: playerId
    }, playerId);
  }

  handleChat(playerId, message) {
    const player = this.players.get(playerId);
    if (!player) return;

    this.broadcast({
      type: 'chat',
      playerId: playerId,
      playerName: player.name,
      message: message,
      timestamp: Date.now()
    });
  }

  updatePlayerData(playerId, data) {
    const player = this.players.get(playerId);
    if (!player) return;

    player.data = { ...player.data, ...data };

    // 全員に更新を通知
    this.broadcast({
      type: 'playerDataUpdate',
      playerId: playerId,
      data: player.data
    });
  }

  broadcast(message, excludePlayerId = null) {
    const messageStr = JSON.stringify(message);
    
    for (const [playerId, player] of this.players) {
      if (playerId !== excludePlayerId && player.ws.readyState === 1) {
        try {
          player.ws.send(messageStr);
        } catch (e) {
          console.error(`Failed to send to ${playerId}:`, e);
        }
      }
    }
  }

  send(ws, message) {
    if (ws.readyState === 1) {
      try {
        ws.send(JSON.stringify(message));
      } catch (e) {
        console.error('Failed to send message:', e);
      }
    }
  }

  isEmpty() {
    return this.players.size === 0;
  }

  isInactive(timeoutMs = 30 * 60 * 1000) {
    // 30分間アクティビティがない場合は非アクティブ
    return Date.now() - this.lastActivity.getTime() > timeoutMs;
  }

  toJSON() {
    return {
      roomId: this.roomId,
      gameType: this.gameType,
      maxPlayers: this.maxPlayers,
      playersCount: this.players.size,
      isStarted: this.isStarted,
      createdAt: this.createdAt,
      lastActivity: this.lastActivity,
      players: Array.from(this.players.values()).map(p => ({
        playerNumber: p.playerNumber,
        name: p.name
      }))
    };
  }
}

// ========================================
// グローバル管理
// ========================================

const rooms = new Map(); // roomId -> GameRoom
const htmlStorage = new Map(); // id -> { html, uploadedAt, size }

// 定期的に非アクティブなルームを削除
setInterval(() => {
  for (const [roomId, room] of rooms) {
    if (room.isEmpty() || room.isInactive()) {
      rooms.delete(roomId);
      console.log(`🗑️ Removed inactive room: ${roomId}`);
    }
  }
}, 5 * 60 * 1000); // 5分ごと

// ========================================
// ユーティリティ
// ========================================

function generateId(length = 8) {
  return crypto.randomBytes(length).toString('hex').substring(0, length);
}

function generateRoomId() {
  let roomId;
  do {
    roomId = generateId(6).toUpperCase();
  } while (rooms.has(roomId));
  return roomId;
}

// ========================================
// REST API
// ========================================

app.use(express.json({ limit: '50mb' }));
app.use(express.text({ limit: '50mb' }));

// CORS
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  next();
});

// HTMLアップロード
app.post('/upload/:id', (req, res) => {
  const id = req.params.id;
  const html = req.body;
  
  if (!html || typeof html !== 'string') {
    return res.status(400).json({ error: 'Invalid HTML content' });
  }
  
  htmlStorage.set(id, {
    html: html,
    uploadedAt: new Date(),
    size: html.length
  });
  
  console.log(`📤 HTML uploaded: ${id} (${html.length} bytes)`);
  
  res.json({
    success: true,
    id: id,
    size: html.length,
    downloadUrl: `${req.protocol}://${req.get('host')}/download/${id}`,
    gameUrl: `${req.protocol}://${req.get('host')}/game/${id}`
  });
});

// HTMLダウンロード
app.get('/download/:id', (req, res) => {
  const id = req.params.id;
  const data = htmlStorage.get(id);
  
  if (!data) {
    return res.status(404).json({ error: 'HTML not found' });
  }
  
  console.log(`📥 HTML downloaded: ${id}`);
  
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(data.html);
});

// ゲーム起動ページ
app.get('/game/:id', (req, res) => {
  const id = req.params.id;
  const data = htmlStorage.get(id);
  
  if (!data) {
    return res.status(404).send('Game not found');
  }
  
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(data.html);
});

// ルーム作成 API
app.post('/api/rooms/create', (req, res) => {
  const { gameType, maxPlayers, roomId } = req.body;
  
  const id = roomId || generateRoomId();
  
  if (rooms.has(id)) {
    return res.status(400).json({ error: 'Room already exists' });
  }
  
  const room = new GameRoom(id, gameType || 'generic', maxPlayers || 4);
  rooms.set(id, room);
  
  console.log(`🎮 Room created: ${id} (${gameType})`);
  
  res.json({
    success: true,
    roomId: id,
    gameType: room.gameType,
    maxPlayers: room.maxPlayers,
    websocketUrl: `wss://${req.get('host')}?room=${id}`
  });
});

// ルーム一覧
app.get('/api/rooms', (req, res) => {
  const gameType = req.query.gameType;
  
  let roomList = Array.from(rooms.values());
  
  if (gameType) {
    roomList = roomList.filter(r => r.gameType === gameType);
  }
  
  res.json({
    total: roomList.length,
    rooms: roomList.map(r => r.toJSON())
  });
});

// ルーム詳細
app.get('/api/rooms/:roomId', (req, res) => {
  const room = rooms.get(req.params.roomId);
  
  if (!room) {
    return res.status(404).json({ error: 'Room not found' });
  }
  
  res.json(room.toJSON());
});

// ルーム削除
app.delete('/api/rooms/:roomId', (req, res) => {
  const roomId = req.params.roomId;
  
  if (rooms.delete(roomId)) {
    console.log(`🗑️ Room deleted: ${roomId}`);
    res.json({ success: true });
  } else {
    res.status(404).json({ error: 'Room not found' });
  }
});

// 統計情報
app.get('/api/stats', (req, res) => {
  const stats = {
    totalRooms: rooms.size,
    totalPlayers: Array.from(rooms.values()).reduce((sum, r) => sum + r.players.size, 0),
    gamesInProgress: Array.from(rooms.values()).filter(r => r.isStarted).length,
    gameTypes: {}
  };
  
  for (const room of rooms.values()) {
    if (!stats.gameTypes[room.gameType]) {
      stats.gameTypes[room.gameType] = 0;
    }
    stats.gameTypes[room.gameType]++;
  }
  
  res.json(stats);
});

// ホームページ
app.get('/', (req, res) => {
  res.send(`
<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>🎮 Universal Game Platform</title>
<style>
body {
  font-family: -apple-system, sans-serif;
  max-width: 1200px;
  margin: 0 auto;
  padding: 40px 20px;
  background: linear-gradient(135deg, #667eea, #764ba2);
  color: white;
}
.container {
  background: rgba(0, 0, 0, 0.3);
  padding: 40px;
  border-radius: 16px;
  backdrop-filter: blur(10px);
}
h1 {
  font-size: 48px;
  margin-bottom: 10px;
  text-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);
}
.subtitle {
  font-size: 18px;
  color: rgba(255, 255, 255, 0.8);
  margin-bottom: 40px;
}
.feature-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
  gap: 20px;
  margin: 30px 0;
}
.feature-card {
  background: rgba(255, 255, 255, 0.1);
  padding: 24px;
  border-radius: 12px;
  border: 2px solid rgba(255, 255, 255, 0.2);
}
.feature-card h3 {
  font-size: 24px;
  margin-bottom: 12px;
}
.stats {
  display: flex;
  gap: 20px;
  margin: 30px 0;
  flex-wrap: wrap;
}
.stat-box {
  background: rgba(255, 255, 255, 0.15);
  padding: 20px 30px;
  border-radius: 12px;
  text-align: center;
  flex: 1;
  min-width: 150px;
}
.stat-number {
  font-size: 36px;
  font-weight: bold;
  color: #00ff88;
}
.stat-label {
  font-size: 14px;
  color: rgba(255, 255, 255, 0.7);
  margin-top: 8px;
}
button {
  background: linear-gradient(135deg, #00ff88, #00d4ff);
  color: #000;
  border: none;
  padding: 14px 28px;
  border-radius: 8px;
  font-size: 16px;
  font-weight: bold;
  cursor: pointer;
  margin: 10px 5px;
}
button:hover {
  transform: translateY(-2px);
  box-shadow: 0 8px 24px rgba(0, 255, 136, 0.4);
}
code {
  background: rgba(0, 0, 0, 0.5);
  padding: 2px 8px;
  border-radius: 4px;
  font-size: 14px;
  color: #00ff88;
}
.section {
  margin: 40px 0;
  padding: 30px;
  background: rgba(255, 255, 255, 0.05);
  border-radius: 12px;
}
</style>
</head>
<body>
<div class="container">
  <h1>🎮 Universal Game Platform</h1>
  <p class="subtitle">どんなマルチプレイゲームでも簡単に作れる統合プラットフォーム</p>
  
  <div class="stats" id="stats">
    <div class="stat-box">
      <div class="stat-number" id="totalRooms">-</div>
      <div class="stat-label">アクティブルーム</div>
    </div>
    <div class="stat-box">
      <div class="stat-number" id="totalPlayers">-</div>
      <div class="stat-label">オンラインプレイヤー</div>
    </div>
    <div class="stat-box">
      <div class="stat-number" id="gamesInProgress">-</div>
      <div class="stat-label">進行中のゲーム</div>
    </div>
  </div>
  
  <div class="feature-grid">
    <div class="feature-card">
      <h3>🚀 簡単デプロイ</h3>
      <p>HTMLをアップロードするだけで即座にマルチプレイゲームが動作</p>
    </div>
    <div class="feature-card">
      <h3>🌐 リアルタイム通信</h3>
      <p>WebSocketで低遅延の双方向通信を実現</p>
    </div>
    <div class="feature-card">
      <h3>🎯 汎用性</h3>
      <p>あらゆるジャンルのゲームに対応可能な柔軟な設計</p>
    </div>
    <div class="feature-card">
      <h3>📊 ルーム管理</h3>
      <p>自動ルーム作成、プレイヤー管理、状態同期</p>
    </div>
  </div>
  
  <div class="section">
    <h2>📚 API ドキュメント</h2>
    
    <h3>1. HTMLアップロード</h3>
    <code>POST /upload/:id</code>
    <p>ゲームのHTMLをアップロード</p>
    
    <h3>2. ルーム作成</h3>
    <code>POST /api/rooms/create</code>
    <p>新しいゲームルームを作成</p>
    
    <h3>3. WebSocket接続</h3>
    <code>wss://your-server.com?room=ROOM_ID</code>
    <p>ゲームルームに接続</p>
    
    <h3>4. ルーム一覧</h3>
    <code>GET /api/rooms</code>
    <p>アクティブなルーム一覧を取得</p>
  </div>
  
  <div class="section">
    <h2>🎮 対応ゲームタイプ</h2>
    <ul style="line-height: 2;">
      <li>🏒 アクションゲーム（エアホッケー、シューティング等）</li>
      <li>🃏 カードゲーム（トランプ、TCG等）</li>
      <li>🎲 ボードゲーム（オセロ、チェス等）</li>
      <li>🎯 パズルゲーム（協力パズル等）</li>
      <li>🏎️ レースゲーム</li>
      <li>⚔️ 対戦格闘ゲーム</li>
      <li>🗺️ MMORPG</li>
      <li>...その他あらゆるジャンル</li>
    </ul>
  </div>
  
  <div style="text-align: center; margin-top: 40px;">
    <button onclick="location.href='/docs'">📖 詳細ドキュメント</button>
    <button onclick="location.href='/api/rooms'">🎮 ルーム一覧</button>
  </div>
</div>

<script>
async function loadStats() {
  try {
    const response = await fetch('/api/stats');
    const stats = await response.json();
    
    document.getElementById('totalRooms').textContent = stats.totalRooms;
    document.getElementById('totalPlayers').textContent = stats.totalPlayers;
    document.getElementById('gamesInProgress').textContent = stats.gamesInProgress;
  } catch (e) {
    console.error('Failed to load stats:', e);
  }
}

loadStats();
setInterval(loadStats, 5000);
</script>
</body>
</html>
  `);
});

// ========================================
// WebSocket
// ========================================

wss.on('connection', (ws, req) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const roomId = url.searchParams.get('room');
  const playerId = generateId();
  
  if (!roomId) {
    ws.send(JSON.stringify({ type: 'error', message: 'Room ID required' }));
    ws.close();
    return;
  }
  
  console.log(`🔌 Connection: ${playerId} -> room ${roomId}`);
  
  ws.on('message', (message) => {
    try {
      const data = JSON.parse(message.toString());
      
      // ルーム参加リクエスト
      if (data.type === 'join') {
        let room = rooms.get(roomId);
        
        // ルームが存在しない場合は作成
        if (!room) {
          room = new GameRoom(
            roomId,
            data.gameType || 'generic',
            data.maxPlayers || 4
          );
          rooms.set(roomId, room);
          console.log(`🎮 Auto-created room: ${roomId}`);
        }
        
        const result = room.addPlayer(ws, playerId, data.playerName);
        
        if (!result.success) {
          ws.send(JSON.stringify({ type: 'error', message: result.error }));
          ws.close();
        }
        
        return;
      }
      
      // その他のメッセージはルームに転送
      const room = rooms.get(roomId);
      if (room) {
        room.handleMessage(playerId, data);
      }
      
    } catch (e) {
      console.error('WebSocket message error:', e);
    }
  });
  
  ws.on('close', () => {
    const room = rooms.get(roomId);
    if (room) {
      room.removePlayer(playerId);
      
      // ルームが空になったら削除
      if (room.isEmpty()) {
        rooms.delete(roomId);
        console.log(`🗑️ Room ${roomId} deleted (empty)`);
      }
    }
  });
  
  ws.on('error', (error) => {
    console.error('WebSocket error:', error);
  });
});

// ========================================
// サーバー起動
// ========================================

const PORT = process.env.PORT || 8080;
server.listen(PORT, () => {
  console.log(`🚀 Universal Game Platform running on port ${PORT}`);
  console.log(`📤 Upload: POST /upload/:id`);
  console.log(`🎮 Create Room: POST /api/rooms/create`);
  console.log(`🌐 WebSocket: wss://localhost:${PORT}?room=ROOM_ID`);
  console.log(`📊 Stats: GET /api/stats`);
});
