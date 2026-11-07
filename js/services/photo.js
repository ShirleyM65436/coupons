// services/photo.js - image downscaling for stored card photos.
// Contract: see ARCHITECTURE.md "services/photo.js".

/** Decode a Blob into something drawable, honouring EXIF orientation. */
async function decode(blob) {
  try {
    return await createImageBitmap(blob, { imageOrientation: 'from-image' });
  } catch {
    // Older browsers: fall back to an <img> (modern browsers apply EXIF orientation to <img> by default).
    const url = URL.createObjectURL(blob);
    try {
      const img = new Image();
      img.src = url;
      await img.decode();
      return img;
    } finally {
      URL.revokeObjectURL(url);
    }
  }
}

/**
 * Downscale an image so its longest side is <= maxDimension and re-encode as JPEG.
 * Respects EXIF orientation. Never upscales.
 * @param {Blob} imageBlob  File from <input type=file> or any image Blob
 * @param {{ maxDimension?: number, quality?: number }} [opts]  defaults 1600 / 0.8
 * @returns {Promise<Blob>} image/jpeg
 */
export async function downscaleImage(imageBlob, { maxDimension = 1600, quality = 0.8 } = {}) {
  const source = await decode(imageBlob);
  const srcW = source.naturalWidth || source.width;
  const srcH = source.naturalHeight || source.height;
  const scale = Math.min(1, maxDimension / Math.max(srcW, srcH)); // never upscale
  const w = Math.max(1, Math.round(srcW * scale));
  const h = Math.max(1, Math.round(srcH * scale));

  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff'; // JPEG has no alpha: transparent areas become white, not black
  ctx.fillRect(0, 0, w, h);
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(source, 0, 0, w, h);
  source.close?.();

  const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', quality));
  if (!blob) throw new Error('Could not encode the image');
  return blob;
}
