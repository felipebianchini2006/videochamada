'use strict';

const { spawn } = require('node:child_process');
const net = require('node:net');
const path = require('node:path');

function getAvailablePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();

    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

async function waitForHealth(baseUrl, timeoutMs = 10000) {
  const startedAt = Date.now();
  const url = `${baseUrl}/healthz`;

  while (Date.now() - startedAt < timeoutMs) {
    try {
      const response = await fetch(url);
      if (response.ok) {
        return;
      }
    } catch (error) {
      // O servidor ainda pode estar iniciando.
    }

    await new Promise((resolve) => setTimeout(resolve, 120));
  }

  throw new Error(`Timeout aguardando healthcheck em ${url}`);
}

function waitForExit(child, timeoutMs = 3000) {
  return new Promise((resolve) => {
    if (child.exitCode !== null) {
      resolve();
      return;
    }

    const timer = setTimeout(() => {
      resolve();
    }, timeoutMs);

    child.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

async function startServerProcess(options = {}) {
  const { env = {}, port } = options;
  const resolvedPort = port || (await getAvailablePort());
  const baseUrl = `http://127.0.0.1:${resolvedPort}`;

  let logs = '';
  const serverPath = path.resolve(__dirname, '../../server.js');
  const child = spawn(process.execPath, [serverPath], {
    cwd: path.resolve(__dirname, '../..'),
    env: {
      ...process.env,
      NODE_ENV: 'test',
      PORT: String(resolvedPort),
      ...env
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });

  child.stdout.on('data', (chunk) => {
    logs += chunk.toString();
  });

  child.stderr.on('data', (chunk) => {
    logs += chunk.toString();
  });

  await waitForHealth(baseUrl);

  async function stop() {
    if (child.exitCode !== null) {
      return;
    }

    child.kill('SIGTERM');
    await waitForExit(child, 2500);

    if (child.exitCode === null) {
      child.kill('SIGKILL');
      await waitForExit(child, 1500);
    }
  }

  return {
    baseUrl,
    port: resolvedPort,
    stop,
    getLogs: () => logs
  };
}

module.exports = {
  startServerProcess
};
