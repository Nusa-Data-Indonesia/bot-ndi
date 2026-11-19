'use strict';

const net = require('node:net');
const tls = require('node:tls');

function blocked(destination) {
  const error = new Error('EXTERNAL_NETWORK_BLOCKED');
  error.code = 'EXTERNAL_NETWORK_BLOCKED';
  error.destination = destination;
  return error;
}

function hostFrom(args) {
  const first = args[0];
  if (first && typeof first === 'object') {
    return first.host || first.hostname || first.servername || first.path || 'localhost';
  }
  if (typeof first === 'string' && !/^\d+$/.test(first)) return first;
  return typeof args[1] === 'string' ? args[1] : 'localhost';
}

function isLoopback(host) {
  const value = String(host).replace(/^\[|\]$/g, '').toLowerCase();
  return value.startsWith('/') || value.startsWith('\\\\.\\pipe\\')
    || value === 'localhost' || value === '::1' || value === '0:0:0:0:0:0:0:1'
    || value === '127.0.0.1' || value.startsWith('127.');
}

const connect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function guardedConnect(...args) {
  const host = hostFrom(args);
  if (!isLoopback(host)) throw blocked(host);
  return connect.apply(this, args);
};

const netConnect = net.connect;
net.connect = function guardedNetConnect(...args) {
  const host = hostFrom(args);
  if (!isLoopback(host)) throw blocked(host);
  return netConnect.apply(net, args);
};
net.createConnection = net.connect;

const tlsConnect = tls.connect;
tls.connect = function guardedTlsConnect(...args) {
  const host = hostFrom(args);
  if (!isLoopback(host)) throw blocked(host);
  return tlsConnect.apply(this, args);
};

if (typeof globalThis.fetch === 'function') {
  const fetch = globalThis.fetch.bind(globalThis);
  globalThis.fetch = (input, init) => {
    let url;
    try { url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url); }
    catch { return Promise.reject(blocked('invalid-url')); }
    if (!isLoopback(url.hostname)) return Promise.reject(blocked(url.hostname));
    return fetch(input, init);
  };
}
