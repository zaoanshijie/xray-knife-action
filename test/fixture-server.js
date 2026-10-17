'use strict';

/*
 * CI fixture: serves a base64 subscription pointing at the local test Xray
 * server plus a target page, so the end-to-end job needs no account and no
 * Python. Usage: node test/fixture-server.js [port] [nodePort]
 */

const http = require('http');

const PORT = Number(process.argv[2] || 18080);
const NODE_PORT = Number(process.argv[3] || 20000);
const UUID = 'b831381d-6324-4d53-ad4f-8cda48b30811';

const link = `vless://${UUID}@127.0.0.1:${NODE_PORT}?encryption=none&security=none&type=tcp#ci-node`;
const subscription = Buffer.from(link, 'utf8').toString('base64');

http
  .createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      if (req.url.startsWith('/sub.txt')) {
        res.writeHead(200, { 'content-type': 'text/plain' });
        res.end(subscription);
        return;
      }
      const body = Buffer.concat(chunks).toString();
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end(`ok-through-the-tunnel ${req.method} ${req.url} body=${body.length}\n`);
    });
  })
  .listen(PORT, '127.0.0.1', () => {
    console.log(`fixture listening on 127.0.0.1:${PORT}`);
  });
