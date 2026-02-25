'use strict';

const { io: createClient } = require('socket.io-client');

function waitForEvent(emitter, eventName, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      emitter.off(eventName, onEvent);
      reject(new Error(`Timeout aguardando evento "${eventName}"`));
    }, timeoutMs);

    function onEvent(payload) {
      clearTimeout(timer);
      resolve(payload);
    }

    emitter.once(eventName, onEvent);
  });
}

function expectNoEvent(emitter, eventName, timeoutMs = 700) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      emitter.off(eventName, onEvent);
      resolve();
    }, timeoutMs);

    function onEvent(payload) {
      clearTimeout(timer);
      reject(new Error(`Evento "${eventName}" não esperado: ${JSON.stringify(payload)}`));
    }

    emitter.once(eventName, onEvent);
  });
}

async function connectSocket(baseUrl) {
  const socket = createClient(baseUrl, {
    transports: ['websocket'],
    reconnection: false,
    forceNew: true
  });

  const connectErrorPromise = waitForEvent(socket, 'connect_error', 4000).then((error) => {
    throw new Error(`Falha ao conectar socket: ${error.message}`);
  });

  const connectPromise = waitForEvent(socket, 'connect', 4000);
  await Promise.race([connectPromise, connectErrorPromise]);

  return socket;
}

async function disconnectSockets(sockets) {
  await Promise.all(
    sockets.map(
      (socket) =>
        new Promise((resolve) => {
          if (!socket || socket.disconnected) {
            resolve();
            return;
          }

          const timer = setTimeout(() => {
            resolve();
          }, 500);

          socket.once('disconnect', () => {
            clearTimeout(timer);
            resolve();
          });

          socket.disconnect();
        })
    )
  );
}

module.exports = {
  connectSocket,
  disconnectSockets,
  expectNoEvent,
  waitForEvent
};
