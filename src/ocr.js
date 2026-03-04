/**
 * OCR Module - Extracts text from images using Gemini 2.5 Flash
 *
 * Uses Google's multimodal AI to read handwritten notes, screenshots,
 * diagrams, etc. and return clean markdown text.
 */

const { GoogleGenerativeAI } = require('@google/generative-ai');
const fs = require('fs');

const MIME_TYPES = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.heic': 'image/heic',
};

async function ocrImage(imagePath) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('GEMINI_API_KEY not set');

  const genAI = new GoogleGenerativeAI(apiKey);
  const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });

  const imageData = fs.readFileSync(imagePath);
  const ext = require('path').extname(imagePath).toLowerCase();
  const mimeType = MIME_TYPES[ext] || 'image/jpeg';

  const result = await model.generateContent([
    {
      inlineData: {
        data: imageData.toString('base64'),
        mimeType,
      },
    },
    'Extract all text from this image. Return clean markdown. Use # for headings, - for bullets. Preserve the writer\'s exact words. Do not summarize or restructure. If the image contains a diagram, describe its structure briefly after the text.',
  ]);

  const text = result.response.text();
  if (!text || text.trim().length === 0) {
    throw new Error('OCR returned empty text — image may not contain readable text');
  }

  return text.trim();
}

module.exports = { ocrImage, MIME_TYPES };
