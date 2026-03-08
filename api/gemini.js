const { GoogleGenAI } = require('@google/genai');
const config = require('./config');

const imageCache = new Map(); // itemId -> { imageUrl, base64 }

async function generateItemImage(itemName, itemDescription, imagePrompt, itemId) {
  const apiKey = config.geminiApiKey;
  if (!apiKey) throw new Error('GEMINI_API_KEY not configured');

  const cached = itemId ? imageCache.get(itemId) : null;
  if (cached) return cached;

  const ai = new GoogleGenAI({ apiKey });
  const prompt = imagePrompt || `Pixel art game item, ${itemName}, ${itemDescription}, dark fantasy, 400x400`;

  const models = [
    'gemini-3.1-flash-image-preview',
    'gemini-2.5-flash-preview-04-17',
    'gemini-2.0-flash-preview-image-generation',
    'gemini-2.5-flash-preview',
    'gemini-2.0-flash-exp',
  ];

  let imageBytes = null;
  let lastError = null;

  for (const model of models) {
    try {
      const res = await ai.models.generateContent({
        model,
        contents: [{ role: 'user', parts: [{ text: `Generate a pixel art image: ${prompt}` }] }],
        config: { responseModalities: ['IMAGE', 'TEXT'] },
      });
      const part = res?.candidates?.[0]?.content?.parts?.find((p) => p.inlineData);
      if (part?.inlineData?.data) {
        imageBytes = part.inlineData.data;
        break;
      }
    } catch (e) {
      lastError = e;
      continue;
    }
  }

  if (!imageBytes && lastError) {
    throw new Error(`Image generation failed: ${lastError?.message || 'No model supported image output'}`);
  }

  if (!imageBytes) throw new Error('No image data returned from Gemini');

  const base64 = typeof imageBytes === 'string' ? imageBytes : Buffer.from(imageBytes).toString('base64');
  const entry = { base64, imageUrl: `data:image/png;base64,${base64}` };
  if (itemId) imageCache.set(itemId, entry);
  return entry;
}

module.exports = { generateItemImage, imageCache };
