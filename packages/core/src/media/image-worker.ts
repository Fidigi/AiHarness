import { parentPort, workerData } from 'node:worker_threads';
import { processImageBytes, type ImageProcessingInput } from './image-processing.js';
if (!parentPort) throw new Error('Image processing requires a worker.');
try { parentPort.postMessage({ type: 'image.prepared', value: await processImageBytes(workerData as ImageProcessingInput) }); }
catch { parentPort.postMessage({ type: 'image.prepared', value: null }); }
