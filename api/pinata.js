const { PinataSDK } = require('pinata');
const config = require('./config');

let pinata = null;
function getPinata() {
  if (!config.pinataJwt) throw new Error('PINATA_JWT not configured');
  if (!pinata) pinata = new PinataSDK({ pinataJwt: config.pinataJwt, pinataGateway: config.pinataGateway });
  return pinata;
}

async function uploadMetadata(metadata) {
  const p = getPinata();
  const res = await p.upload.json(metadata);
  const cid = res?.cid;
  if (!cid) throw new Error('Pinata upload failed: no CID in response');
  return `ipfs://${cid}`;
}

async function uploadImage(buffer, filename = 'image.png') {
  const p = getPinata();
  const base64 = Buffer.isBuffer(buffer) ? buffer.toString('base64') : String(buffer).replace(/^data:image\/\w+;base64,/, '');
  const res = await p.upload.base64(base64, { metadata: { name: filename } });
  const cid = res?.cid;
  if (!cid) throw new Error('Pinata image upload failed: no CID');
  return `ipfs://${cid}`;
}

module.exports = {
  uploadMetadata,
  uploadImage,
};
