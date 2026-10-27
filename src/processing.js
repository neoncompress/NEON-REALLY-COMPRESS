// NEON COMPRESS V3 — TIKTOK QUALITY PROCESSOR
// H.264 High Profile + CRF 16
// Preserve source resolution and frame rate.
// MP4 output + AAC audio.
// Quality + FPS metadata patch is applied after local encoding.
// TikTok can still transcode/compress uploads; no code can guarantee zero blur.

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
    onStatus('Loading video processor…');

    ffmpeg = await getFFmpeg();

    const fileData = new Uint8Array(
      await file.arrayBuffer().catch(() => {
        throw new Error(
          'The browser could not read the selected video file.'
        );
      })
    );

    if (fileData.length === 0) {
      throw new Error('The selected video file is empty.');
    }

    onProgress(3);

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
