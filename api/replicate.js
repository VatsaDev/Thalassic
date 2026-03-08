const config = require('./config');

const imageCache = new Map(); // itemId -> { imageUrl, base64 }
const RATE_LIMIT_MS = 12000; // 12s between requests (5/min, under Replicate's 6/min free tier)
let lastRequestTime = 0;
let pending = Promise.resolve();

function rateLimitedRun(fn) {
  pending = pending.then(async () => {
    const elapsed = Date.now() - lastRequestTime;
    if (elapsed < RATE_LIMIT_MS) {
      await new Promise((r) => setTimeout(r, RATE_LIMIT_MS - elapsed));
    }
    const result = await fn();
    lastRequestTime = Date.now();
    return result;
  });
  return pending;
}

async function generateItemImage(itemName, itemDescription, imagePrompt, itemId) {
  const token = config.replicateApiToken;
  if (!token) throw new Error('REPLICATE_API_TOKEN not configured');

  const cached = itemId ? imageCache.get(itemId) : null;
  if (cached) return cached;

  const prompt = imagePrompt || `Pixel art game item, ${itemName}, ${itemDescription}, dark fantasy, 400x400`;
  const fullPrompt = `Pixel art style, ${prompt}, game asset icon`;

  const Replicate = require('replicate');
  const client = new Replicate({ auth: token });

  const output = await rateLimitedRun(() =>
    client.run('black-forest-labs/flux-schnell', {
      input: { prompt: fullPrompt },
    })
  );

  const first = Array.isArray(output) ? output[0] : output;
  let imageUrl = null;
  if (typeof first === 'string') imageUrl = first;
  else if (first && typeof first.url === 'function') imageUrl = first.url();
  else if (first && first.url) imageUrl = first.url;
  if (!imageUrl) {
    throw new Error('No image URL returned from Replicate');
  }

  const res = await fetch(imageUrl);
  if (!res.ok) throw new Error(`Failed to fetch image: ${res.status}`);
  const buffer = Buffer.from(await res.arrayBuffer());
  const base64 = buffer.toString('base64');
  const mime = (res.headers.get('content-type') || 'image/png').split(';')[0].trim();
  const dataUrl = `data:${mime};base64,${base64}`;

  const entry = { base64, imageUrl: dataUrl };
  if (itemId) imageCache.set(itemId, entry);
  return entry;
}

module.exports = { generateItemImage, imageCache };
