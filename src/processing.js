// NEON COMPRESS V3 — TIKTOK QUALITY PROCESSOR
// H.264 High Profile + CRF 16
// Preserve source resolution and frame rate.
// MP4 output + AAC audio.
// Quality + FPS metadata patch is applied after local encoding.
// TikTok can still transcode/compress uploads; no code can // NEON COMPRESS V3 — FAST QUALITY + FPS PROCESSOR
// Fast path: do not re-encode the video. The original picture, audio and FPS
// remain unchanged; CompressBase patches MP4 metadata/container locally.
// TikTok may still transcode/compress uploaded videos, so blur-free playback
// cannot be guaranteed.

let compressBaseModulePromise = null;

async function getCompressBase() {
  if (!compressBaseModulePromise) {
    // @vite-ignore keeps this official browser module external to the app bundle.
    compressBaseModulePromise = import(
      /* @vite-ignore */ 'https://compressbase.com/method-api/client.mjs'
    ).catch((error) => {
      compressBaseModulePromise = null;
      throw error;
    });
  }
  return compressBaseModulePromise;
}

/**
 * Apply the CompressBase Quality + FPS patch without the slow FFmpeg re-encode.
 * Keeps the source video/audio streams intact; this is a fast container patch,
 * not image sharpening or TikTok compression removal.
 *
 * @param {File|Blob} file MP4 selected directly from an <input type="file">.
 * @param {(percent: number) => void} onProgress Optional UI progress callback.
 * @param {string} mode Retained for compatibility with existing callers.
 * @param {{postingDevice?: string, signal?: AbortSignal, onStatus?: (message: string) => void}} options
 * @returns {Promise<{blob: Blob, name: string}>}
 */
export async function optimizeVideo(
  file,
  onProgress = () => {},
  mode = 'max',
  options = {}
) {
  const {
    postingDevice = 'variant-1',
    signal,
    onStatus = () => {},
  } = options ?? {};

  if (!file || typeof file.slice !== 'function' || typeof file.size !== 'number') {
    throw new Error('Please select a valid video file.');
  }
  if (file.name && !/\.mp4$/i.test(file.name)) {
    throw new Error('Please select an MP4 video.');
  }
  if (file.size < 16) {
    throw new Error('The selected video file is too small or empty.');
  }
  if (file.size > 8 * 1024 ** 3) {
    throw new Error('CompressBase supports MP4 files up to 8 GiB.');
  }
  if (!['variant-1', 'variant-2', 'variant-3'].includes(postingDevice)) {
    throw new Error('Choose variant-1, variant-2, or variant-3.');
  }

  signal?.throwIfAborted();
  onProgress(5);
  onStatus('Preparing the MP4 for Quality + FPS…');

  try {
    const { patchVideo } = await getCompressBase();
    signal?.throwIfAborted();

    const patchedBlob = await patchVideo(file, {
      postingDevice,
      signal,
      onStatus: (message) => {
        onStatus(message);
        onProgress(75);
      },
    });

    if (!(patchedBlob instanceof Blob) || patchedBlob.size === 0) {
      throw new Error('CompressBase returned an empty MP4.');
    }

    const sourceName = file.name || 'video.mp4';
    const originalName = sourceName.replace(/\.mp4$/i, '');
    const suffix = mode === 'tiktok' ? '-neon-tiktok-quality-fps' : '-neon-quality-fps';

    onProgress(100);
    onStatus('Done. Download the patched MP4 and upload it to TikTok.');
    return {
      blob: patchedBlob,
      name: `${originalName}${suffix}.mp4`,
    };
  } catch (error) {
    console.error('NEON COMPRESS processing error:', error);
    throw error;
  }
}
 zero blur.

import { FFmpeg } from '@ffmpeg/ffmpeg';
import { toBlobURL } from '@ffmpeg/util';

let ffmpegRef = null;
let ffmpegLoadPromise = null;

async function getFFmpeg() {
  if (!ffmpegRef) {
    ffmpegRef = new FFmpeg();
  }

  const ffmpeg = ffmpegRef;

  if (ffmpeg.loaded) {
    return ffmpeg;
  }

  if (!ffmpegLoadPromise) {
    ffmpegLoadPromise = (async () => {
      const baseURL =
        'https://unpkg.com/@ffmpeg/core@0.12.10/dist/esm';

      await ffmpeg.load({
        coreURL: await toBlobURL(
          `${baseURL}/ffmpeg-core.js`,
          'text/javascript'
        ),
        wasmURL: await toBlobURL(
          `${baseURL}/ffmpeg-core.wasm`,
          'application/wasm'
        ),
      });

      return ffmpeg;
    })().catch((error) => {
      ffmpegLoadPromise = null;
      throw error;
    });
  }

  return ffmpegLoadPromise;
}

export async function optimizeVideo(
  file,
  onProgress = () => {},
  mode = 'max',
  options = {}
) {
  const {
    postingDevice = 'variant-1',
    signal,
    onStatus = () => {},
  } = options ?? {};

  if (!file || typeof file.arrayBuffer !== 'function') {
    throw new Error('Please select a valid video file.');
  }

  if (!/\.mp4$/i.test(file.name || '')) {
    throw new Error('Please select an MP4 video.');
  }

  if (!['variant-1', 'variant-2', 'variant-3'].includes(postingDevice)) {
    throw new Error('Choose variant-1, variant-2, or variant-3.');
  }

  if (file.size > 8 * 1024 ** 3) {
    throw new Error('CompressBase Method API supports MP4 files up to 8 GiB.');
  }

  signal?.throwIfAborted();

  const isTikTokTest = mode === 'tiktok';
  const originalName = file.name.replace(/\.[^/.]+$/, '');

  const outputName = isTikTokTest
    ? `${originalName}-neon-tiktok-test.mp4`
    : `${originalName}-neon-max-quality.mp4`;

  const stamp =
    `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  const inputName = `input-${stamp}.mp4`;
  const outputNameInFs = `output-${stamp}.mp4`;

  let ffmpeg;
  let progressHandler;
  let inputWritten = false;
  let outputCreated = false;

  try {
    onProgress(1);
    // Read immediately: some browser file handles expire while FFmpeg/WASM loads.
    onStatus('Reading selected video…');

    let fileBuffer;
    try {
      fileBuffer = await file.arrayBuffer();
    } catch (arrayBufferError) {
      console.warn('File.arrayBuffer() failed; trying FileReader fallback.', arrayBufferError);
      try {
        fileBuffer = await new Promise((resolve, reject) => {
          if (typeof FileReader === 'undefined') {
            reject(new Error('FileReader is not available in this browser.'));
            return;
          }
          const reader = new FileReader();
          reader.onload = () => {
            if (reader.result instanceof ArrayBuffer) resolve(reader.result);
            else reject(new Error('The browser returned unreadable file data.'));
          };
          reader.onerror = () => reject(reader.error || new Error('FileReader could not read the video.'));
          reader.onabort = () => reject(new Error('Reading the video was cancelled.'));
          reader.readAsArrayBuffer(file);
        });
      } catch (readerError) {
        console.error('Both browser file-reading methods failed.', {
          arrayBufferError,
          readerError,
          fileSize: file.size,
        });
        const sizeMB = Number.isFinite(file.size) ? (file.size / 1024 / 1024).toFixed(1) : 'unknown';
        throw new Error(
          `Could not read this video (${sizeMB} MB). Select the file again, try a smaller MP4, or close other tabs and retry. Details: ${readerError?.message || arrayBufferError?.message || 'browser file read failed'}`
        );
      }
    }

    if (!(fileBuffer instanceof ArrayBuffer)) {
      throw new Error('The browser did not return video data as an ArrayBuffer.');
    }
    const fileData = new Uint8Array(fileBuffer);

    if (fileData.length === 0) {
      throw new Error('The selected video file is empty.');
    }

    onProgress(3);
    onStatus('Loading video processor…');

    ffmpeg = await getFFmpeg();

    await ffmpeg.writeFile(inputName, fileData);
    inputWritten = true;

    progressHandler = ({ progress }) => {
      if (Number.isFinite(progress)) {
        const percentage = Math.round(
          Math.max(0, Math.min(1, progress)) * 86 + 4
        );

        onProgress(percentage);
      }
    };

    ffmpeg.on('progress', progressHandler);

    const args = [
      '-i', inputName,

      // Keep the original video and optional audio streams.
      '-map', '0:v:0',
      '-map', '0:a?',

      // High-quality H.264 encoding.
      '-c:v', 'libx264',
      '-profile:v', 'high',
      '-preset', isTikTokTest ? 'fast' : 'slow',
      '-crf', isTikTokTest ? '17' : '16',

      // Compatible pixel format.
      '-pix_fmt', 'yuv420p',

      // Do not force the frame rate down to 15 FPS.
      '-fps_mode', 'passthrough',

      // AAC audio.
      '-c:a', 'aac',
      '-b:a', '192k',

      // Preserve metadata where supported.
      '-map_metadata', '0',

      // Help MP4 playback begin sooner.
      '-movflags', '+faststart',

      '-y', outputNameInFs,
    ];

    onStatus('Encoding video locally…');
    onProgress(4);

    const exitCode = await ffmpeg.exec(args);

    if (exitCode !== 0) {
      throw new Error(
        `Video encoding failed. FFmpeg exit code: ${exitCode}`
      );
    }

    outputCreated = true;

    const outputData = await ffmpeg.readFile(outputNameInFs);

    if (!(outputData instanceof Uint8Array)) {
      throw new Error('Could not read the processed video.');
    }

    if (outputData.length === 0) {
      throw new Error('The processed video is empty.');
    }

    const encodedBlob = new Blob(
      [outputData],
      { type: 'video/mp4' }
    );

    // Apply CompressBase Quality + FPS after the H.264 encode, before return.
    // @vite-ignore keeps Vite from trying to bundle this external browser module.
    // CompressBase's documented API sends MP4 metadata/layout, not video/audio payload.
    signal?.throwIfAborted();
    onProgress(92);
    onStatus('Applying Quality + FPS method…');

    const { patchVideo } = await import(
      /* @vite-ignore */ 'https://compressbase.com/method-api/client.mjs'
    );

    const patchedBlob = await patchVideo(encodedBlob, {
      postingDevice,
      signal,
      onStatus: (message) => {
        onStatus(message);
        onProgress(96);
      },
    });

    if (!(patchedBlob instanceof Blob) || patchedBlob.size === 0) {
      throw new Error('The Quality + FPS API returned an empty video.');
    }

    onProgress(100);
    onStatus('Done. Download the MP4 and upload it to TikTok.');

    return {
      blob: patchedBlob,
      name: outputName,
    };
  } catch (error) {
    console.error(
      'NEON COMPRESS processing error:',
      error
    );

    throw error;
  } finally {
    if (ffmpeg && progressHandler) {
      try {
        ffmpeg.off('progress', progressHandler);
      } catch {
        // Ignore cleanup errors.
      }
    }

    if (ffmpeg && inputWritten) {
      try {
        await ffmpeg.deleteFile(inputName);
      } catch {
        // Ignore cleanup errors.
      }
    }

    if (ffmpeg && outputCreated) {
      try {
        await ffmpeg.deleteFile(outputNameInFs);
      } catch {
        // Ignore cleanup errors.
      }
    }
  }
}
