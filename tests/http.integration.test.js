'use strict';

const crypto = require('node:crypto');
const { startServerProcess } = require('./helpers/server-process');

describe('HTTP integration', () => {
  let serverHandle;

  beforeAll(async () => {
    serverHandle = await startServerProcess({
      env: {
        STUN_URLS: 'stun:stun.l.google.com:19302',
        TURN_URLS: 'turn:turn.example.com:3478?transport=udp,turn:turn.example.com:3478?transport=tcp',
        TURN_SHARED_SECRET: 'test-shared-secret',
        TURN_CREDENTIAL_TTL_SECONDS: '600'
      }
    });
  }, 15000);

  afterAll(async () => {
    await serverHandle.stop();
  });

  it('GET /healthz deve retornar status ok', async () => {
    const response = await fetch(`${serverHandle.baseUrl}/healthz`);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.status).toBe('ok');
    expect(typeof body.uptime).toBe('number');
    expect(Number.isNaN(Date.parse(body.timestamp))).toBe(false);
  });

  it('GET /call/:roomId deve renderizar a tela quando roomId for UUID v4', async () => {
    const roomId = crypto.randomUUID();
    const response = await fetch(`${serverHandle.baseUrl}/call/${roomId}`);
    const html = await response.text();

    expect(response.status).toBe(200);
    expect(html).toContain('Videochamada 1:1');
    expect(html).toContain(roomId);
  });

  it('GET /call/:roomId deve retornar 400 quando roomId for inválido', async () => {
    const response = await fetch(`${serverHandle.baseUrl}/call/room-invalida`);
    expect(response.status).toBe(400);
  });

  it('GET /api/webrtc/ice-config deve retornar 400 quando roomId for inválido', async () => {
    const response = await fetch(`${serverHandle.baseUrl}/api/webrtc/ice-config?roomId=abc`);
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error).toBe('INVALID_ROOM_ID');
  });

  it('GET /api/webrtc/ice-config deve retornar STUN + TURN efêmero para roomId válido', async () => {
    const roomId = crypto.randomUUID();
    const now = Math.floor(Date.now() / 1000);

    const response = await fetch(
      `${serverHandle.baseUrl}/api/webrtc/ice-config?roomId=${encodeURIComponent(roomId)}`
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(body.iceTransportPolicy).toBe('all');
    expect(Array.isArray(body.iceServers)).toBe(true);
    expect(body.iceServers.length).toBeGreaterThanOrEqual(2);

    const stunServer = body.iceServers.find(
      (server) => Array.isArray(server.urls) && server.urls.some((url) => url.startsWith('stun:'))
    );
    expect(stunServer).toBeDefined();

    const turnServer = body.iceServers.find(
      (server) => Array.isArray(server.urls) && server.urls.some((url) => url.startsWith('turn:'))
    );
    expect(turnServer).toBeDefined();
    expect(turnServer.username.endsWith(`:${roomId}`)).toBe(true);
    expect(typeof turnServer.credential).toBe('string');
    expect(turnServer.credential.length).toBeGreaterThan(10);

    const [expiresAtRaw] = turnServer.username.split(':');
    const expiresAt = Number(expiresAtRaw);
    expect(Number.isNaN(expiresAt)).toBe(false);
    expect(expiresAt).toBeGreaterThan(now);
  });
});
