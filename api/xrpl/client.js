const { Client, isValidXAddress, xAddressToClassicAddress } = require('xrpl');
const config = require('../config');

let client = null;

async function getClient() {
  if (client && client.isConnected()) return client;
  client = new Client(config.xrplUrl);
  await client.connect();
  return client;
}

async function disconnect() {
  if (client) {
    if (client.isConnected()) await client.disconnect();
    client = null;
  }
}

function isValidAddress(address) {
  if (!address || typeof address !== 'string') return false;
  const r = /^r[1-9A-HJ-NP-Za-km-z]{24,34}$/;
  const x = /^X[1-9A-HJ-NP-Za-km-z]{46}$/;
  return r.test(address.trim()) || x.test(address.trim());
}

function toClassicAddress(address) {
  if (!address || typeof address !== 'string') return null;
  const s = address.trim();
  if (s.startsWith('r')) return isValidAddress(s) ? s : null;
  if (s.startsWith('X') && isValidXAddress(s)) {
    try {
      const decoded = xAddressToClassicAddress(s);
      return decoded?.classicAddress || s;
    } catch (_) { return s; }
  }
  return isValidAddress(s) ? s : null;
}

module.exports = { getClient, disconnect, isValidAddress, toClassicAddress };
