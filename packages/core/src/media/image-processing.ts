import sharp from 'sharp';

export interface ImageResizeLimits { maxWidth: number; maxHeight: number; maxBytes: number; jpegQuality: number }
export interface ImageProcessingInput { bytes: Uint8Array; mimeType: string; limits: ImageResizeLimits; autoResize: boolean }
export interface ProcessedImage { data: string; mimeType: string; width?: number; height?: number; originalWidth?: number; originalHeight?: number; resized: boolean; hints: string[] }
const supported = new Map([['png', 'image/png'], ['jpeg', 'image/jpeg'], ['gif', 'image/gif'], ['webp', 'image/webp']]);
const normalizeMime = (mime: string) => mime.split(';')[0].trim().toLowerCase().replace(/^image\/jpg$/u, 'image/jpeg');

/** Executed only in an owned worker. No filenames, URLs, SVG/PDF or ambient image plugins. */
export async function processImageBytes(input: ImageProcessingInput): Promise<ProcessedImage | null> {
  sharp.cache(false); sharp.concurrency(1);
  const bytes = Buffer.from(input.bytes), mime = normalizeMime(input.mimeType), { limits } = input;
  const encode = (data: Buffer, mimeType: string) => ({ data: data.toString('base64'), mimeType });
  if (!input.autoResize && [...supported.values()].includes(mime)) return { ...encode(bytes, mime), resized: false, hints: [] };
  const signature = bytes.subarray(0, 12), ascii = signature.toString('ascii');
  if (!(signature.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) || signature[0] === 255 && signature[1] === 216
    || /^GIF8[79]a/u.test(ascii) || ascii.startsWith('RIFF') && ascii.slice(8) === 'WEBP'
    || signature.subarray(0, 4).equals(Buffer.from([73, 73, 42, 0])) || signature.subarray(0, 4).equals(Buffer.from([77, 77, 0, 42]))
    || ascii.slice(4, 8) === 'ftyp' && /^(?:avif|avis|heic|heix|hevc|hevx|mif1|msf1)$/u.test(ascii.slice(8)))) return null;
  const image = () => sharp(bytes, { limitInputPixels: 40_000_000, pages: 1, failOn: 'warning' });
  const metadata = await image().metadata();
  if (!metadata.width || !metadata.height || !metadata.format || ![...supported.keys(), 'tiff', 'heif', 'avif'].includes(metadata.format)) return null;
  const rotated = (metadata.orientation ?? 1) >= 5;
  const originalWidth = rotated ? metadata.height : metadata.width, originalHeight = rotated ? metadata.width : metadata.height;
  const nativeMime = supported.get(metadata.format);
  const hints: string[] = [];
  if (mime !== nativeMime) hints.push(`[Image converted from ${mime} to ${nativeMime ?? 'image/png'}.]`);
  if (nativeMime && (!input.autoResize || originalWidth <= limits.maxWidth && originalHeight <= limits.maxHeight && Math.ceil(bytes.length / 3) * 4 < limits.maxBytes)) {
    return { ...encode(bytes, nativeMime), width: originalWidth, height: originalHeight, originalWidth, originalHeight, resized: false, hints };
  }
  if (!input.autoResize) return { ...encode(await image().rotate().png().toBuffer(), 'image/png'), width: originalWidth, height: originalHeight, originalWidth, originalHeight, resized: false, hints };
  let width = originalWidth, height = originalHeight;
  if (width > limits.maxWidth) { height = Math.max(1, Math.round(height * limits.maxWidth / width)); width = limits.maxWidth; }
  if (height > limits.maxHeight) { width = Math.max(1, Math.round(width * limits.maxHeight / height)); height = limits.maxHeight; }
  for (;;) {
    const resized = () => image().rotate().resize(width, height, { fit: 'fill', kernel: 'lanczos3' });
    const png = await resized().png().toBuffer();
    let result = encode(png, 'image/png');
    if (result.data.length >= limits.maxBytes) {
      for (const quality of new Set([limits.jpegQuality, 85, 70, 55, 40])) {
        result = encode(await resized().jpeg({ quality }).toBuffer(), 'image/jpeg');
        if (result.data.length < limits.maxBytes) break;
      }
    }
    if (result.data.length < limits.maxBytes) return { ...result, width, height, originalWidth, originalHeight, resized: true,
      hints: [...hints, `[Image: original ${originalWidth}x${originalHeight}, displayed at ${width}x${height}. Multiply coordinates by ${(originalWidth / width).toFixed(2)} to map to original image.]`] };
    if (width === 1 && height === 1) return null;
    width = Math.max(1, Math.floor(width * 0.75)); height = Math.max(1, Math.floor(height * 0.75));
  }
}
