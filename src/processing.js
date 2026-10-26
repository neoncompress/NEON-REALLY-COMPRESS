// NEON COMPRESS V3 — TIKTOK QUALITY PROCESSOR
// H.264 High Profile + CRF 16
// Preserve source resolution and frame rate.
// MP4 output + AAC audio.
// No forced 480x320 scaling or 15 FPS conversion.

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
  mode = 'max'
) {
  if (!file || typeof file.arrayBuffer !== 'function') {
    throw new Error('Please select a valid video file.');
  }

  if (!/\.mp4$/i.test(file.name)) {
    throw new Error('Please select an MP4 video.');
  }

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
          Math.max(0, Math.min(1, progress)) * 94 + 4
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

    const outputBlob = new Blob(
      [outputData],
      { type: 'video/mp4' }
    );

    onProgress(100);

    return {
      blob: outputBlob,
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
