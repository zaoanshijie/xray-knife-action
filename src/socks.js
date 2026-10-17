'use strict';

/*
 * Minimal SOCKS5 client (CONNECT, no auth) used by the HTTP relay and by the
 * action's own health checks.
 */

const net = require('net');

function encodeIPv4(host) {
  const parts = host.split('.').map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return null;
  }
  return Buffer.concat([Buffer.from([0x01]), Buffer.from(parts)]);
}

function encodeIPv6(host) {
  const address = host.split('%')[0]; // drop zone id
  if (address.includes('.')) return null; // IPv4-mapped form, use domain encoding instead

  let groups;
  if (address.includes('::')) {
    const [headPart, tailPart] = address.split('::');
    const head = headPart ? headPart.split(':') : [];
    const tail = tailPart ? tailPart.split(':') : [];
    const fill = 8 - head.length - tail.length;
    if (fill < 0) return null;
    groups = [...head, ...new Array(fill).fill('0'), ...tail];
  } else {
    groups = address.split(':');
  }
  if (groups.length !== 8) return null;

  const buffer = Buffer.alloc(17);
  buffer[0] = 0x04;
  for (let i = 0; i < 8; i += 1) {
    const value = Number.parseInt(groups[i] || '0', 16);
    if (!Number.isInteger(value)) return null;
    buffer.writeUInt16BE(value, 1 + i * 2);
  }
  return buffer;
}

function encodeAddress(host) {
  const ipv4 = net.isIPv4(host) ? encodeIPv4(host) : null;
  if (ipv4) return ipv4;

  const ipv6 = net.isIPv6(host) ? encodeIPv6(host) : null;
  if (ipv6) return ipv6;

  const name = Buffer.from(host, 'utf8');
  if (name.length === 0 || name.length > 255) throw new Error(`invalid target host: ${host}`);
  return Buffer.concat([Buffer.from([0x03, name.length]), name]);
}

/**
 * Open a TCP tunnel to host:port through a SOCKS5 proxy.
 *
 * @returns {Promise<net.Socket>} a connected socket, positioned right after the
 *   SOCKS handshake (any early payload is pushed back onto the stream).
 */
function socksConnect({ socksHost = '127.0.0.1', socksPort, host, port, timeout = 10000 }) {
  return new Promise((resolve, reject) => {
    if (!Number.isInteger(port) || port <= 0 || port > 65535) {
      reject(new Error(`invalid target port: ${port}`));
      return;
    }

    let socket;
    try {
      socket = net.connect({ host: socksHost, port: socksPort });
    } catch (error) {
      reject(error);
      return;
    }

    let stage = 0;
    let buffer = Buffer.alloc(0);
    let settled = false;

    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.removeListener('data', onData);
      if (error) {
        socket.destroy();
        reject(error);
      } else {
        // Keep an error listener so a later ECONNRESET cannot crash the process.
        socket.on('error', () => socket.destroy());
        resolve(socket);
      }
    };

    const timer = setTimeout(() => finish(new Error(`SOCKS5 handshake timed out (${timeout}ms)`)), timeout);

    const onData = (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);

      if (stage === 0) {
        if (buffer.length < 2) return;
        if (buffer[0] !== 0x05) return finish(new Error('SOCKS5: unexpected protocol version'));
        if (buffer[1] !== 0x00) return finish(new Error('SOCKS5: proxy requires authentication'));
        buffer = buffer.subarray(2);
        stage = 1;

        const portBuffer = Buffer.alloc(2);
        portBuffer.writeUInt16BE(port, 0);
        try {
          socket.write(Buffer.concat([Buffer.from([0x05, 0x01, 0x00]), encodeAddress(host), portBuffer]));
        } catch (error) {
          finish(error);
          return;
        }
      }

      if (stage === 1) {
        if (buffer.length < 4) return;
        const reply = buffer[1];
        const atyp = buffer[3];
        let length;
        if (atyp === 0x01) length = 10;
        else if (atyp === 0x04) length = 22;
        else if (atyp === 0x03) {
          if (buffer.length < 5) return;
          length = 7 + buffer[4];
        } else return finish(new Error(`SOCKS5: unsupported address type ${atyp}`));

        if (buffer.length < length) return;
        if (reply !== 0x00) return finish(new Error(`SOCKS5: connect failed (reply ${reply})`));

        const rest = buffer.subarray(length);
        stage = 2;
        if (rest.length) socket.unshift(rest);
        finish(null);
      }
    };

    socket.on('data', onData);
    // Greeting first: the proxy will not answer until it sees the methods list.
    socket.once('connect', () => socket.write(Buffer.from([0x05, 0x01, 0x00])));
    socket.once('error', (error) => finish(error));
    socket.once('close', () => finish(new Error('SOCKS5: connection closed during handshake')));
  });
}

module.exports = { socksConnect, encodeAddress };
