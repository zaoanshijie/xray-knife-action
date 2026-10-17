'use strict';

/*
 * Unit tests for the SOCKS5 address encoder.
 * Run with: node test/socks.test.js
 */

const assert = require('assert');
const { encodeAddress } = require('../src/socks');

// IPv4 -> ATYP 0x01 + 4 bytes
assert.deepStrictEqual(Array.from(encodeAddress('127.0.0.1')), [0x01, 127, 0, 0, 1]);
assert.deepStrictEqual(Array.from(encodeAddress('8.8.4.4')), [0x01, 8, 8, 4, 4]);

// IPv6 -> ATYP 0x04 + 16 bytes
const loopback = encodeAddress('::1');
assert.strictEqual(loopback[0], 0x04);
assert.strictEqual(loopback.length, 17);
assert.strictEqual(loopback.readUInt16BE(15), 1);

const full = encodeAddress('2001:db8:0:0:0:0:0:1');
assert.strictEqual(full[0], 0x04);
assert.strictEqual(full.readUInt16BE(1), 0x2001);
assert.strictEqual(full.readUInt16BE(3), 0x0db8);
assert.strictEqual(full.readUInt16BE(15), 1);

// zone id is dropped
assert.deepStrictEqual(Array.from(encodeAddress('fe80::1%eth0')), Array.from(encodeAddress('fe80::1')));

// domain -> ATYP 0x03 + length + bytes
const domain = encodeAddress('example.com');
assert.strictEqual(domain[0], 0x03);
assert.strictEqual(domain[1], 'example.com'.length);
assert.strictEqual(domain.subarray(2).toString(), 'example.com');

// IPv4-mapped IPv6 falls back to domain encoding rather than throwing
const mapped = encodeAddress('::ffff:192.0.2.1');
assert.strictEqual(mapped[0], 0x03);
assert.strictEqual(mapped.subarray(2).toString(), '::ffff:192.0.2.1');

assert.throws(() => encodeAddress(''), /invalid target host/);

console.log('socks address encoding ok');
