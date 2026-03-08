const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');
const { generateItemImage } = require('../imageGen');
const { uploadImage } = require('../pinata');

const itemsPath = path.join(__dirname, '../../config/items.json');

function loadItems() {
  const raw = fs.readFileSync(itemsPath, 'utf8');
  return JSON.parse(raw);
}

router.get('/items', (req, res) => {
  try {
    const items = loadItems();
    res.json(items.map((i) => ({
      id: i.id,
      name: i.name,
      description: i.description,
      cost: i.cost,
      rarity: i.rarity,
      type: i.type,
      imagePrompt: i.imagePrompt,
      staticImage: i.staticImage || null,
    })));
  } catch (err) {
    console.error('Items list error:', err);
    res.status(500).json({ error: err.message || 'Failed to load items' });
  }
});

function placeholderSvg(rarity) {
  const colors = { common: '#888', uncommon: '#4CAF50', rare: '#2196F3', legendary: '#ffd700' };
  const c = colors[rarity] || '#666';
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 120"><rect fill="${c}" width="120" height="120"/><text x="60" y="65" fill="#111" font-size="24" font-family="sans-serif" text-anchor="middle">?</text></svg>`;
  return 'data:image/svg+xml,' + encodeURIComponent(svg);
}

router.post('/generate-image', async (req, res) => {
  try {
    const { itemName, itemDescription, itemId, imagePrompt, rarity } = req.body;
    if (!itemName || !itemDescription) {
      return res.status(400).json({ error: 'itemName and itemDescription required' });
    }

    let result;
    try {
      result = await generateItemImage(itemName, itemDescription, imagePrompt, itemId || null);
    } catch (err) {
      console.warn('Image gen failed, using placeholder:', err?.message);
      const imageUrl = placeholderSvg(rarity || 'common');
      return res.json({ imageUrl, fallback: true });
    }

    const shouldUpload = req.query.upload === 'true';
    if (shouldUpload && result.base64) {
      const buffer = Buffer.from(result.base64, 'base64');
      const cid = await uploadImage(buffer, `${itemId || 'item'}.png`);
      const gateway = require('../config').pinataGateway || 'https://gateway.pinata.cloud';
      const imageUrl = cid.replace('ipfs://', `${gateway}/ipfs/`);
      return res.json({ imageUrl, base64: result.base64 });
    }

    res.json({ imageUrl: result.imageUrl, base64: result.base64 });
  } catch (err) {
    console.error('Generate image error:', err);
    const imageUrl = placeholderSvg(req.body?.rarity || 'common');
    res.json({ imageUrl, fallback: true });
  }
});

module.exports = router;
