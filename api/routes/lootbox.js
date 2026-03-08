const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');
const { mintToWallet } = require('../xrpl/mint');
const { uploadMetadata, uploadImage } = require('../pinata');
const { generateItemImage } = require('../imageGen');

const itemsPath = path.join(__dirname, '../../config/items.json');
const gameDir = path.join(__dirname, '../../game');

function loadItems() {
  const raw = fs.readFileSync(itemsPath, 'utf8');
  return JSON.parse(raw);
}

function getImageBufferForItem(item, itemId) {
  if (item.staticImage) {
    const staticPath = path.join(gameDir, item.staticImage.replace(/^\//, ''));
    if (fs.existsSync(staticPath)) {
      return fs.readFileSync(staticPath);
    }
  }
  return null;
}

router.post('/purchase', async (req, res) => {
  try {
    const { itemId, walletAddress } = req.body;
    if (!itemId || !walletAddress) {
      return res.status(400).json({ error: 'itemId and walletAddress required' });
    }

    const items = loadItems();
    const item = items.find((i) => i.id === itemId);
    if (!item) {
      return res.status(404).json({ error: 'Item not found' });
    }

    let buffer = getImageBufferForItem(item, itemId);
    if (!buffer) {
      try {
        const { base64 } = await generateItemImage(
          item.name,
          item.description,
          item.imagePrompt,
          itemId
        );
        buffer = Buffer.from(base64, 'base64');
      } catch (err) {
        console.warn('Image gen failed for mint, using fallback:', err?.message);
        const fallbackPath = path.join(gameDir, 'assets/armor1.png');
        if (fs.existsSync(fallbackPath)) {
          buffer = fs.readFileSync(fallbackPath);
        } else {
          throw new Error('Image generation failed and no fallback image found. Add game/assets/armor1.png or configure REPLICATE_API_TOKEN/GEMINI_API_KEY.');
        }
      }
    }

    const imageCid = await uploadImage(buffer, `${itemId}.png`);
    const gateway = require('../config').pinataGateway || 'https://gateway.pinata.cloud';
    const imageUrl = imageCid.replace('ipfs://', `${gateway}/ipfs/`);

    const metadata = {
      name: item.name,
      description: item.description,
      image: imageUrl,
      attributes: [
        { trait_type: 'Rarity', value: item.rarity },
        { trait_type: 'Type', value: item.type || 'item' },
        { trait_type: 'ItemId', value: itemId },
      ],
    };

    const metadataUri = await uploadMetadata(metadata);

    const { nftokenId, offerId } = await mintToWallet(metadataUri, walletAddress.trim());

    res.json({
      success: true,
      nftokenId,
      offerId,
      message: `NFT minted. Accept the offer in your wallet to receive it.`,
    });
  } catch (err) {
    console.error('Purchase error:', err);
    res.status(500).json({ error: err.message || 'Purchase failed' });
  }
});

module.exports = router;
