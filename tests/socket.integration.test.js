'use strict';

const crypto = require('node:crypto');
const { startServerProcess } = require('./helpers/server-process');
const {
  connectSocket,
  disconnectSockets,
  expectNoEvent,
  waitForEvent
} = require('./helpers/socket-utils');

describe('Socket.io signaling integration', () => {
  let serverHandle;
  let connectedSockets = [];

  async function createSocket() {
    const socket = await connectSocket(serverHandle.baseUrl);
    connectedSockets.push(socket);
    return socket;
  }

  async function joinRoom(socket, roomId) {
    socket.emit('room:join', { roomId });
    return waitForEvent(socket, 'room:joined');
  }

  beforeAll(async () => {
    serverHandle = await startServerProcess();
  }, 15000);

  afterEach(async () => {
    await disconnectSockets(connectedSockets);
    connectedSockets = [];
  });

  afterAll(async () => {
    await serverHandle.stop();
  });

  it('deve aceitar 2 participantes por sala e bloquear o 3º com room:full', async () => {
    const roomId = crypto.randomUUID();
    const socketA = await createSocket();
    const socketB = await createSocket();
    const socketC = await createSocket();

    const joinedA = await joinRoom(socketA, roomId);
    expect(joinedA.participantCount).toBe(1);

    const peerJoinedOnA = waitForEvent(socketA, 'room:peer-joined');
    const joinedBPromise = joinRoom(socketB, roomId);

    const [joinedB, peerJoinedPayload] = await Promise.all([joinedBPromise, peerJoinedOnA]);
    expect(joinedB.participantCount).toBe(2);
    expect(peerJoinedPayload.peerId).toBe(socketB.id);

    socketC.emit('room:join', { roomId });
    const roomFullPayload = await waitForEvent(socketC, 'room:full');
    expect(roomFullPayload.maxParticipants).toBe(2);
  });

  it('deve propagar webrtc:offer e media:state somente para o par da mesma sala', async () => {
    const roomA = crypto.randomUUID();
    const roomB = crypto.randomUUID();

    const callerA = await createSocket();
    const calleeA = await createSocket();
    const callerB = await createSocket();
    const calleeB = await createSocket();

    await joinRoom(callerA, roomA);
    await joinRoom(calleeA, roomA);
    await joinRoom(callerB, roomB);
    await joinRoom(calleeB, roomB);

    const sdpPayload = {
      type: 'offer',
      sdp: 'fake-offer-sdp'
    };

    const noOfferInOtherRoom = expectNoEvent(calleeB, 'webrtc:offer');
    const offerOnPeer = waitForEvent(calleeA, 'webrtc:offer');
    callerA.emit('webrtc:offer', { roomId: roomA, sdp: sdpPayload });

    const receivedOffer = await offerOnPeer;
    await noOfferInOtherRoom;

    expect(receivedOffer.sdp).toEqual(sdpPayload);

    const noMediaStateInOtherRoom = expectNoEvent(calleeB, 'media:state');
    const mediaStateOnPeer = waitForEvent(calleeA, 'media:state');
    callerA.emit('media:state', { roomId: roomA, audioEnabled: false, videoEnabled: true });

    const receivedMediaState = await mediaStateOnPeer;
    await noMediaStateInOtherRoom;

    expect(receivedMediaState.peerId).toBe(callerA.id);
    expect(receivedMediaState.audioEnabled).toBe(false);
    expect(receivedMediaState.videoEnabled).toBe(true);
  });

  it('deve emitir room:peer-left quando um participante desconecta', async () => {
    const roomId = crypto.randomUUID();
    const socketA = await createSocket();
    const socketB = await createSocket();

    await joinRoom(socketA, roomId);
    await joinRoom(socketB, roomId);

    const leavingPeerId = socketA.id;
    const peerLeftPromise = waitForEvent(socketB, 'room:peer-left');

    socketA.disconnect();
    const peerLeft = await peerLeftPromise;

    expect(peerLeft.peerId).toBe(leavingPeerId);
  });

  it('deve retornar erro NOT_IN_ROOM ao sinalizar sem estar na sala', async () => {
    const socket = await createSocket();
    const roomId = crypto.randomUUID();

    socket.emit('webrtc:offer', {
      roomId,
      sdp: { type: 'offer', sdp: 'fake' }
    });

    const errorPayload = await waitForEvent(socket, 'error');
    expect(errorPayload.code).toBe('NOT_IN_ROOM');
  });
});
