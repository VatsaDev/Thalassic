const { Wallet, getNFTokenID } = require('xrpl');
const { getClient, isValidAddress, toClassicAddress } = require('./client');
const config = require('../config');

const FLAGS = { tsTransferable: 8, tfBurnable: 1 };

function uriToHex(uri) {
  return Buffer.from(uri, 'utf8').toString('hex').toUpperCase();
}

async function mintToWallet(metadataUri, walletAddress) {
  if (!config.issuerSecret) throw new Error('ISSUER_SECRET not configured');
  const classicAddr = toClassicAddress(walletAddress);
  if (!classicAddr || !isValidAddress(classicAddr)) throw new Error('Invalid wallet address');

  const client = await getClient();
  const wallet = Wallet.fromSeed(config.issuerSecret);
  const hexUri = uriToHex(metadataUri);
  if (hexUri.length > 512) throw new Error('URI exceeds 256 bytes when hex-encoded');

  const mintTx = {
    TransactionType: 'NFTokenMint',
    Account: wallet.address,
    NFTokenTaxon: config.nftokenTaxon,
    URI: hexUri,
    TransferFee: config.transferFee,
    Flags: FLAGS.tsTransferable | FLAGS.tfBurnable,
  };

  const prepared = await client.autofill(mintTx);
  const signed = wallet.sign(prepared);
  const result = await client.submitAndWait(signed.tx_blob);

  if (result.result.meta.TransactionResult !== 'tesSUCCESS') {
    throw new Error(`Mint failed: ${result.result.meta.TransactionResult}`);
  }

  const nftokenId = getNFTokenID(result.result.meta);
  if (!nftokenId) throw new Error('Could not extract NFTokenID');

  let offerId = null;
  if (wallet.address !== classicAddr) {
    offerId = await createTransferOffer(client, wallet, nftokenId, classicAddr);
  }

  return { nftokenId, offerId };
}

async function createTransferOffer(client, issuerWallet, nftokenId, destinationAddress) {
  const tx = {
    TransactionType: 'NFTokenCreateOffer',
    Account: issuerWallet.address,
    NFTokenID: nftokenId,
    Amount: '0',
    Destination: destinationAddress,
    Flags: 1, // tfSell: issuer sells (owner offers), required for sell offers
  };
  const prepared = await client.autofill(tx);
  const signed = issuerWallet.sign(prepared);
  const result = await client.submitAndWait(signed.tx_blob);
  if (result.result.meta.TransactionResult !== 'tesSUCCESS') {
    throw new Error(`Sell offer failed: ${result.result.meta.TransactionResult}`);
  }
  const meta = result.result.meta;
  for (const node of meta.AffectedNodes || []) {
    const created = node.CreatedNode;
    if (created?.LedgerEntryType === 'NFTokenOffer') return created.LedgerIndex;
  }
  return null;
}

module.exports = { mintToWallet, uriToHex };
