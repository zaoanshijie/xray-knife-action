'use strict';

/*
 * HTTP proxy relay.
 *
 * xray-knife only guarantees a SOCKS5 listener: xray-core happens to sniff
 * plain HTTP on that port, but the sing-box core does not, and the default
 * (authenticated) inbound speaks SOCKS only. This relay gives every workflow a
 * real HTTP proxy in front of the SOCKS5 listener:
 *
 *   - absolute-URI requests ("GET http://host/path HTTP/1.1") are replayed
 *     through the upstream SOCKS5 socket with a regular http client;
 *   - "CONNECT host:port" is tunneled raw, which is what HTTPS clients use.
 *
 * Zero dependencies; launched as its own detached process by index.js.
 */

const http = require('http');
const { socksConnect } = require('./socks');

const HOP_BY_HOP = new Set([
  'connection',
  'proxy-connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

function parseArgs(argv) {
  const options = { listenPort: 0, socksPort: 0, socksHost: '127.0.0.1' };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (flag === '--listen-port') options.listenPort = Number(value);
    else if (flag === '--socks-port') options.socksPort = Number(value);
    else if (flag === '--socks-host') options.socksHost = value;
  }
  if (!Number.isInteger(options.listenPort) || options.listenPort <= 0) {
    throw new Error('--listen-port is required');
  }
  if (!Number.isInteger(options.socksPort) || options.socksPort <= 0) {
    throw new Error('--socks-port is required');
  }
  return options;
}

const options = parseArgs(process.argv.slice(2));

class SocksAgent extends http.Agent {
  createConnection(requestOptions, callback) {
    socksConnect({
      socksHost: options.socksHost,
      socksPort: options.socksPort,
      host: requestOptions.host,
      port: Number(requestOptions.port) || 80,
      timeout: 15000,
    })
      .then((socket) => callback(null, socket))
      .catch((error) => callback(error));
  }
}

const agent = new SocksAgent({ keepAlive: false });

function filterHeaders(headers) {
  const result = {};
  for (const [key, value] of Object.entries(headers)) {
    if (!HOP_BY_HOP.has(key.toLowerCase())) result[key] = value;
  }
  return result;
}

function sendText(res, status, body) {
  res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8' });
  res.end(`${body}\n`);
}

function handleRequest(req, res) {
  if (!/^https?:\/\//i.test(req.url)) {
    sendText(res, 400, 'This port is an HTTP proxy. Use it as a proxy (HTTP_PROXY / curl -x), not as a website.');
    return;
  }
  if (/^https:\/\//i.test(req.url)) {
    sendText(res, 501, 'Tunneling an https:// URL with an absolute request line is not supported; use CONNECT.');
    return;
  }

  let target;
  try {
    target = new URL(req.url);
  } catch (error) {
    sendText(res, 400, `Invalid target URL: ${req.url}`);
    return;
  }

  const headers = filterHeaders(req.headers);
  headers.host = target.host;

  const upstream = http.request(
    {
      host: target.hostname,
      port: Number(target.port) || 80,
      method: req.method,
      path: `${target.pathname}${target.search}`,
      headers,
      agent,
    },
    (upstreamResponse) => {
      res.writeHead(upstreamResponse.statusCode || 502, filterHeaders(upstreamResponse.headers));
      upstreamResponse.pipe(res);
    }
  );

  upstream.on('error', (error) => {
    if (!res.headersSent) sendText(res, 502, `Upstream request failed: ${error.message}`);
    else res.destroy();
  });

  res.on('close', () => upstream.destroy());
  req.pipe(upstream);
}

function splitHostPort(value) {
  const text = String(value || '');
  if (text.startsWith('[')) {
    const end = text.indexOf(']');
    if (end < 0) return null;
    return { host: text.slice(1, end), port: Number(text.slice(end + 2)) };
  }
  const index = text.lastIndexOf(':');
  if (index <= 0) return null;
  return { host: text.slice(0, index), port: Number(text.slice(index + 1)) };
}

const server = http.createServer(handleRequest);

server.on('connect', (req, clientSocket, head) => {
  const target = splitHostPort(req.url);
  clientSocket.on('error', () => clientSocket.destroy());

  if (!target || !Number.isInteger(target.port) || target.port <= 0) {
    clientSocket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
    return;
  }

  socksConnect({
    socksHost: options.socksHost,
    socksPort: options.socksPort,
    host: target.host,
    port: target.port,
    timeout: 20000,
  })
    .then((upstream) => {
      clientSocket.write('HTTP/1.1 200 Connection Established\r\nProxy-Agent: xray-knife-action\r\n\r\n');
      if (head && head.length) upstream.write(head);
      upstream.pipe(clientSocket);
      clientSocket.pipe(upstream);
      upstream.on('close', () => clientSocket.destroy());
      clientSocket.on('close', () => upstream.destroy());
      upstream.on('error', () => clientSocket.destroy());
    })
    .catch((error) => {
      clientSocket.end(`HTTP/1.1 502 Bad Gateway\r\nX-Proxy-Error: ${error.message}\r\n\r\n`);
    });
});

server.on('clientError', (error, socket) => {
  if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
  socket.destroy();
});

server.listen(options.listenPort, '127.0.0.1', () => {
  process.stdout.write(
    `http proxy listening on http://127.0.0.1:${options.listenPort} -> socks5 ${options.socksHost}:${options.socksPort}\n`
  );
});

server.on('error', (error) => {
  process.stderr.write(`http proxy error: ${error.message}\n`);
  process.exit(1);
});

for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1000).unref();
  });
}

// A bad client must never take the proxy down.
process.on('uncaughtException', (error) => {
  process.stderr.write(`http proxy uncaught exception: ${error.stack || error.message}\n`);
});
process.on('unhandledRejection', (reason) => {
  process.stderr.write(`http proxy unhandled rejection: ${reason && reason.message ? reason.message : reason}\n`);
});
