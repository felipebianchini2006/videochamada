'use strict';

const crypto = require('node:crypto');
const { startServerProcess } = require('../helpers/server-process');
const {
  connectSocket,
  disconnectSockets,
  waitForEvent
} = require('../helpers/socket-utils');

const TOTAL_ROOMS = Number(process.env.LOAD_ROOMS || 300);
const ROOM_BATCH_SIZE = Number(process.env.LOAD_BATCH_SIZE || 30);
const EVENT_TIMEOUT_MS = Number(process.env.LOAD_EVENT_TIMEOUT_MS || 5000);

async function runRoomPair(baseUrl, roomId, socketsRegistry) {
  const peerA = await connectSocket(baseUrl);
  const peerB = await connectSocket(baseUrl);
  socketsRegistry.push(peerA, peerB);

  peerA.emit('room:join', { roomId });
  const joinedA = await waitForEvent(peerA, 'room:joined', EVENT_TIMEOUT_MS);
  if (joinedA.participantCount !== 1) {
    throw new Error(`Sala ${roomId} com participantCount inesperado no peerA: ${joinedA.participantCount}`);
  }

  const peerJoinedEvent = waitForEvent(peerA, 'room:peer-joined', EVENT_TIMEOUT_MS);
  peerB.emit('room:join', { roomId });
  const joinedB = await waitForEvent(peerB, 'room:joined', EVENT_TIMEOUT_MS);
  const peerJoinedPayload = await peerJoinedEvent;

  if (joinedB.participantCount !== 2) {
    throw new Error(`Sala ${roomId} com participantCount inesperado no peerB: ${joinedB.participantCount}`);
  }

  if (peerJoinedPayload.peerId !== peerB.id) {
    throw new Error(`Sala ${roomId} recebeu peerId inesperado em room:peer-joined`);
  }

  const marker = `offer-${roomId}`;
  const offerPromise = waitForEvent(peerB, 'webrtc:offer', EVENT_TIMEOUT_MS);
  peerA.emit('webrtc:offer', {
    roomId,
    sdp: { type: 'offer', sdp: marker }
  });

  const offerPayload = await offerPromise;
  if (!offerPayload.sdp || offerPayload.sdp.sdp !== marker) {
    throw new Error(`Sala ${roomId} falhou em isolamento de sinalização`);
  }
}

function chunkArray(items, size) {
  const chunks = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
}

async function main() {
  console.log(`[load-test] Iniciando teste de carga para ${TOTAL_ROOMS} salas.`);
  const serverHandle = await startServerProcess();
  const allSockets = [];

  try {
    const roomIds = Array.from({ length: TOTAL_ROOMS }, () => crypto.randomUUID());
    const batches = chunkArray(roomIds, ROOM_BATCH_SIZE);
    const startedAt = Date.now();

    for (let index = 0; index < batches.length; index += 1) {
      const batch = batches[index];
      await Promise.all(batch.map((roomId) => runRoomPair(serverHandle.baseUrl, roomId, allSockets)));
      console.log(`[load-test] Lote ${index + 1}/${batches.length} finalizado (${batch.length} salas).`);
    }

    const durationMs = Date.now() - startedAt;
    console.log(
      `[load-test] Sucesso: ${TOTAL_ROOMS} salas 1:1 conectadas sem cross-talk em ${durationMs}ms.`
    );
  } finally {
    await disconnectSockets(allSockets);
    await serverHandle.stop();
  }
}

main().catch((error) => {
  console.error('[load-test] Falha no teste de carga:', error);
  process.exit(1);
});
