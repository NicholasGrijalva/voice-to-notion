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

/**
 * OCR a single image, optionally with user-supplied context (caption).
 *
 * @param {string} imagePath - Path to the image file
 * @param {Object} options
 * @param {string|null} options.context - User caption/context to guide OCR
 * @returns {Promise<string>} Extracted markdown text
 */
async function ocrImage(imagePath, { context = null } = {}) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('GEMINI_API_KEY not set');

  const genAI = new GoogleGenerativeAI(apiKey);
  const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });

  const imageData = fs.readFileSync(imagePath);
  const ext = require('path').extname(imagePath).toLowerCase();
  const mimeType = MIME_TYPES[ext] || 'image/jpeg';

  // Role adoption + format constraints reduce WER by ~56% on handwriting
  let prompt = 'You are the world\'s greatest transcriber of handwritten notes. '
    + 'Extract all text from this image accurately. Return clean markdown. '
    + 'Use # for headings, - for bullets. Preserve the writer\'s exact words. '
    + 'Do not add any words not in the image. Do not summarize or restructure. '
    + 'If the image contains a diagram, describe its structure briefly after the text.';

  if (context) {
    prompt += `\n\nThe user describes this image as: "${context}". `
      + 'Use this context to resolve ambiguous handwriting and understand '
      + 'domain-specific terms, but do not add information beyond what is in the image.';
  }

  const result = await model.generateContent([
    {
      inlineData: {
        data: imageData.toString('base64'),
        mimeType,
      },
    },
    prompt,
  ]);

  const text = result.response.text();
  if (!text || text.trim().length === 0) {
    throw new Error('OCR returned empty text — image may not contain readable text');
  }

  return text.trim();
}

module.exports = { ocrImage, MIME_TYPES };
