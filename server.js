'use strict';

require('dotenv').config();

const crypto = require('node:crypto');
const http = require('node:http');
const path = require('node:path');
const express = require('express');
const { Server } = require('socket.io');
const { validate: uuidValidate, version: uuidVersion } = require('uuid');

const PORT = Number(process.env.PORT || 3000);
const REDIS_URL = process.env.REDIS_URL || '';
const TURN_SHARED_SECRET = process.env.TURN_SHARED_SECRET || '';
const TURN_CREDENTIAL_TTL_SECONDS = Math.max(60, Number(process.env.TURN_CREDENTIAL_TTL_SECONDS || 600));
const ICE_TRANSPORT_POLICY = process.env.ICE_TRANSPORT_POLICY || 'all';
const MAX_PARTICIPANTS_PER_ROOM = 2;
const DEFAULT_STUN_URLS = ['stun:stun.l.google.com:19302'];

const app = express();
if (process.env.TRUST_PROXY === 'true') {
  app.set('trust proxy', 1);
}

const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: true,
    credentials: true
  }
});

const roomMembers = new Map();

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.static(path.join(__dirname, 'public')));

function isUuidV4(value) {
  return typeof value === 'string' && uuidValidate(value) && uuidVersion(value) === 4;
}

function parseCsvEnv(value) {
  if (!value) {
    return [];
  }

  return value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function getStunUrls() {
  const configured = parseCsvEnv(process.env.STUN_URLS);
  return configured.length > 0 ? configured : DEFAULT_STUN_URLS;
}

function getTurnUrls() {
  return parseCsvEnv(process.env.TURN_URLS);
}

function buildTurnServer(roomId) {
  const turnUrls = getTurnUrls();
  if (!TURN_SHARED_SECRET || turnUrls.length === 0) {
    return null;
  }

  const nowInSeconds = Math.floor(Date.now() / 1000);
  const expiresAt = nowInSeconds + TURN_CREDENTIAL_TTL_SECONDS;
  const username = `${expiresAt}:${roomId}`;
  const credential = crypto.createHmac('sha1', TURN_SHARED_SECRET).update(username).digest('base64');

  return {
    urls: turnUrls,
    username,
    credential
  };
}

function buildIceConfig(roomId) {
  const iceServers = [];
  const stunUrls = getStunUrls();

  if (stunUrls.length > 0) {
    iceServers.push({ urls: stunUrls });
  }

  const turnServer = buildTurnServer(roomId);
  if (turnServer) {
    iceServers.push(turnServer);
  }

  return {
    iceTransportPolicy: ICE_TRANSPORT_POLICY,
    iceServers
  };
}

function emitSocketError(socket, code, message) {
  socket.emit('error', { code, message });
}

function getRoomSet(roomId) {
  if (!roomMembers.has(roomId)) {
    roomMembers.set(roomId, new Set());
  }
  return roomMembers.get(roomId);
}

function getRoomSize(roomId) {
  return roomMembers.get(roomId)?.size || 0;
}

function addToRoom(roomId, socketId) {
  const members = getRoomSet(roomId);
  members.add(socketId);
  return members.size;
}

function removeFromRoom(roomId, socketId) {
  const members = roomMembers.get(roomId);
  if (!members) {
    return 0;
  }

  members.delete(socketId);
  if (members.size === 0) {
    roomMembers.delete(roomId);
    return 0;
  }

  return members.size;
}

function isSocketInRoom(socket, roomId) {
  return socket.data.roomId === roomId;
}

function leaveCurrentRoom(socket) {
  const roomId = socket.data.roomId;
  if (!roomId) {
    return;
  }

  socket.leave(roomId);
  removeFromRoom(roomId, socket.id);
  socket.data.roomId = null;
  socket.to(roomId).emit('room:peer-left', { peerId: socket.id });
}

function relayWebRtcEvent(socket, eventName, payload = {}) {
  const { roomId, ...data } = payload;

  if (!isUuidV4(roomId)) {
    emitSocketError(socket, 'INVALID_ROOM_ID', 'roomId inválido para evento de sinalização.');
    return;
  }

  if (!isSocketInRoom(socket, roomId)) {
    emitSocketError(socket, 'NOT_IN_ROOM', 'Socket não está autorizado a sinalizar nesta sala.');
    return;
  }

  socket.to(roomId).emit(eventName, data);
}

app.get('/healthz', (req, res) => {
  res.json({
    status: 'ok',
    uptime: process.uptime(),
    timestamp: new Date().toISOString()
  });
});

app.get('/', (req, res) => {
  const newRoomId = crypto.randomUUID();
  res.redirect(`/call/${newRoomId}`);
});

app.get('/call/:roomId', (req, res) => {
  const { roomId } = req.params;

  if (!isUuidV4(roomId)) {
    return res.status(400).send('roomId inválido. Use UUID v4.');
  }

  return res.render('index', { roomId });
});

app.get('/api/webrtc/ice-config', (req, res) => {
  const { roomId } = req.query;

  if (!isUuidV4(roomId)) {
    return res.status(400).json({
      error: 'INVALID_ROOM_ID',
      message: 'roomId inválido. Use UUID v4.'
    });
  }

  const iceConfig = buildIceConfig(roomId);
  res.setHeader('Cache-Control', 'no-store');
  return res.json(iceConfig);
});

io.on('connection', (socket) => {
  socket.data.roomId = null;

  socket.on('room:join', (payload = {}) => {
    const { roomId } = payload;

    if (!isUuidV4(roomId)) {
      emitSocketError(socket, 'INVALID_ROOM_ID', 'roomId inválido. Use UUID v4.');
      return;
    }

    if (socket.data.roomId === roomId) {
      socket.emit('room:joined', {
        roomId,
        socketId: socket.id,
        participantCount: getRoomSize(roomId)
      });
      return;
    }

    if (socket.data.roomId) {
      leaveCurrentRoom(socket);
    }

    const currentRoomSize = getRoomSize(roomId);
    if (currentRoomSize >= MAX_PARTICIPANTS_PER_ROOM) {
      socket.emit('room:full', {
        roomId,
        maxParticipants: MAX_PARTICIPANTS_PER_ROOM
      });
      return;
    }

    socket.join(roomId);
    const participantCount = addToRoom(roomId, socket.id);
    socket.data.roomId = roomId;

    socket.emit('room:joined', {
      roomId,
      socketId: socket.id,
      participantCount
    });

    socket.to(roomId).emit('room:peer-joined', { peerId: socket.id });
  });

  socket.on('room:leave', (payload = {}) => {
    const currentRoomId = socket.data.roomId;
    if (!currentRoomId) {
      return;
    }

    if (payload.roomId && payload.roomId !== currentRoomId) {
      emitSocketError(socket, 'ROOM_MISMATCH', 'Tentativa de sair de uma sala diferente da atual.');
      return;
    }

    leaveCurrentRoom(socket);
  });

  socket.on('webrtc:offer', (payload) => relayWebRtcEvent(socket, 'webrtc:offer', payload));
  socket.on('webrtc:answer', (payload) => relayWebRtcEvent(socket, 'webrtc:answer', payload));
  socket.on('webrtc:ice-candidate', (payload) => relayWebRtcEvent(socket, 'webrtc:ice-candidate', payload));

  socket.on('media:state', (payload = {}) => {
    const { roomId, audioEnabled, videoEnabled } = payload;

    if (!isUuidV4(roomId)) {
      emitSocketError(socket, 'INVALID_ROOM_ID', 'roomId inválido para media:state.');
      return;
    }

    if (!isSocketInRoom(socket, roomId)) {
      emitSocketError(socket, 'NOT_IN_ROOM', 'Socket não está autorizado para media:state nesta sala.');
      return;
    }

    socket.to(roomId).emit('media:state', {
      peerId: socket.id,
      audioEnabled: Boolean(audioEnabled),
      videoEnabled: Boolean(videoEnabled)
    });
  });

  socket.on('disconnect', () => {
    leaveCurrentRoom(socket);
  });
});

async function setupRedisAdapterIfConfigured() {
  if (!REDIS_URL) {
    console.log('[socket.io] Redis adapter desativado (REDIS_URL não configurada).');
    return null;
  }

  try {
    const { createAdapter } = require('@socket.io/redis-adapter');
    const { createClient } = require('redis');

    const pubClient = createClient({ url: REDIS_URL });
    const subClient = pubClient.duplicate();

    await Promise.all([pubClient.connect(), subClient.connect()]);
    io.adapter(createAdapter(pubClient, subClient));

    console.log('[socket.io] Redis adapter ativado com sucesso.');
    return { pubClient, subClient };
  } catch (error) {
    console.error('[socket.io] Falha ao ativar Redis adapter. Continuando em memória.', error);
    return null;
  }
}

function setupProcessSignals(redisClients) {
  async function shutdown(signal) {
    console.log(`[server] Encerrando (${signal})...`);

    io.close();
    server.close(async () => {
      if (redisClients) {
        await Promise.allSettled([redisClients.pubClient.quit(), redisClients.subClient.quit()]);
      }
      process.exit(0);
    });

    setTimeout(() => {
      process.exit(1);
    }, 5000).unref();
  }

  process.on('SIGINT', () => {
    shutdown('SIGINT');
  });

  process.on('SIGTERM', () => {
    shutdown('SIGTERM');
  });
}

async function start() {
  const redisClients = await setupRedisAdapterIfConfigured();
  setupProcessSignals(redisClients);

  server.listen(PORT, () => {
    console.log(`[server] Escutando em http://localhost:${PORT}`);
  });
}

start().catch((error) => {
  console.error('[server] Erro fatal ao iniciar aplicação.', error);
  process.exit(1);
});
