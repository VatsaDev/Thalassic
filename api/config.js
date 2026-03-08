require('dotenv').config({ path: require('path').join(__dirname, '../.env') });

const XRPL_TESTNET = 'wss://s.altnet.rippletest.net:51233';
const XRPL_MAINNET = 'wss://xrplcluster.com';

let issuerAddress = process.env.ISSUER_ADDRESS?.trim();
if (!issuerAddress && process.env.ISSUER_SECRET) {
  try {
    const { Wallet } = require('xrpl');
    issuerAddress = Wallet.fromSeed(process.env.ISSUER_SECRET).address;
  } catch (_) {}
}

module.exports = {
  xrplUrl: process.env.XRPL_NETWORK === 'mainnet' ? XRPL_MAINNET : XRPL_TESTNET,
  issuerSecret: process.env.ISSUER_SECRET,
  issuerAddress,
  nftokenTaxon: parseInt(process.env.NFTOKEN_TAXON || '1', 10),
  transferFee: parseInt(process.env.TRANSFER_FEE || '250', 10),
  rarityTiers: { common: 1, uncommon: 2, rare: 3, legendary: 4 },
  pinataJwt: process.env.PINATA_JWT,
  pinataGateway: process.env.PINATA_GATEWAY || 'https://gateway.pinata.cloud',
  geminiApiKey: process.env.GEMINI_API_KEY || process.env.GOOGLE_AI_API_KEY,
  replicateApiToken: process.env.REPLICATE_API_TOKEN,
};
