const config = require('./config');

const imageCache = new Map(); // itemId -> { imageUrl, base64 }
const RATE_LIMIT_MS = 12000;
let lastReplicateTime = 0;
let replicatePending = Promise.resolve();

async function rateLimitedReplicate(fn) {
  replicatePending = replicatePending.then(async () => {
    const elapsed = Date.now() - lastReplicateTime;
    if (elapsed < RATE_LIMIT_MS) await new Promise((r) => setTimeout(r, RATE_LIMIT_MS - elapsed));
    const out = await fn();
    lastReplicateTime = Date.now();
    return out;
  });
  return replicatePending;
}

async function generateItemImage(itemName, itemDescription, imagePrompt, itemId) {
  const cached = itemId ? imageCache.get(itemId) : null;
  if (cached) return cached;

  const prompt = imagePrompt || `Pixel art game item, ${itemName}, ${itemDescription}, dark fantasy, 400x400`;

  // Try Replicate first (if token configured)
  if (config.replicateApiToken) {
    try {
      const result = await tryReplicate(prompt, itemId);
      if (result) return result;
    } catch (e) {
      const msg = e?.message || '';
      const skipReplicate = msg.includes('402') || msg.includes('429') || msg.includes('Insufficient credit') || msg.includes('throttled');
      if (!skipReplicate) throw e;
    }
  }

  // Fallback to Gemini (if key configured)
  if (config.geminiApiKey) {
    try {
      return await tryGemini(prompt, itemId);
    } catch (e) {
      // fall through to throw
    }
  }

  throw new Error('Image generation failed. Configure REPLICATE_API_TOKEN or GEMINI_API_KEY, and ensure Replicate has credit.');
}

async function tryReplicate(prompt, itemId) {
  const Replicate = require('replicate');
  const client = new Replicate({ auth: config.replicateApiToken });
  const fullPrompt = `Pixel art style, ${prompt}, game asset icon`;

  const output = await rateLimitedReplicate(() => client.run('black-forest-labs/flux-schnell', {
    input: { prompt: fullPrompt },
  }));

  const first = Array.isArray(output) ? output[0] : output;
  let imageUrl = typeof first === 'string' ? first : (first?.url?.() ?? first?.url);
  if (!imageUrl) throw new Error('No image from Replicate');

  const res = await fetch(imageUrl);
  if (!res.ok) throw new Error(`Replicate fetch: ${res.status}`);
  const buffer = Buffer.from(await res.arrayBuffer());
  const base64 = buffer.toString('base64');
  const mime = (res.headers.get('content-type') || 'image/png').split(';')[0].trim();
  const dataUrl = `data:${mime};base64,${base64}`;
  const entry = { base64, imageUrl: dataUrl };
  if (itemId) imageCache.set(itemId, entry);
  return entry;
}

async function tryGemini(prompt, itemId) {
  const { GoogleGenAI } = require('@google/genai');
  const ai = new GoogleGenAI({ apiKey: config.geminiApiKey });
  const models = ['gemini-2.5-flash-preview', 'gemini-2.0-flash-exp'];

  for (const model of models) {
    try {
      const res = await ai.models.generateContent({
        model,
        contents: [{ role: 'user', parts: [{ text: `Generate a pixel art image: ${prompt}` }] }],
        config: { responseModalities: ['IMAGE', 'TEXT'] },
      });
      const part = res?.candidates?.[0]?.content?.parts?.find((p) => p.inlineData);
      if (part?.inlineData?.data) {
        const base64 = Buffer.from(part.inlineData.data).toString('base64');
        const entry = { base64, imageUrl: `data:image/png;base64,${base64}` };
        if (itemId) imageCache.set(itemId, entry);
        return entry;
      }
    } catch (_) {
      continue;
    }
  }
  throw new Error('Gemini did not return image');
}

module.exports = { generateItemImage, imageCache };
