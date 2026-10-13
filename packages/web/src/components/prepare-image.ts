import type { DraftAttachment } from '../store/session-store';

async function fileDataUrl(file: Blob): Promise<string> {
  return await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error ?? new Error('Image read failed'));
    reader.readAsDataURL(file);
  });
}

export async function prepareImage(file: File): Promise<DraftAttachment> {
  if (file.size > 10 * 1024 * 1024) throw new Error(`Image too large: ${file.name}`);
  let blob: Blob = file;
  if (!['image/gif', 'image/svg+xml'].includes(file.type)) {
    try {
      const bitmap = await createImageBitmap(file);
      const scale = Math.min(1, 2048 / Math.max(bitmap.width, bitmap.height));
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(bitmap.width * scale));
      canvas.height = Math.max(1, Math.round(bitmap.height * scale));
      canvas.getContext('2d')?.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      bitmap.close();
      const compressed = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, 'image/jpeg', .86));
      if (compressed && compressed.size < file.size) blob = compressed;
    } catch { /* Keep the original when browser image decoding is unavailable. */ }
  }
  if (blob.size > 4 * 1024 * 1024) throw new Error(`Compressed image is still too large: ${file.name}`);
  return {
    id: crypto.randomUUID(),
    name: file.name,
    mediaType: blob.type || file.type,
    size: blob.size,
    url: await fileDataUrl(blob),
  };
}
