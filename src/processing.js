// NEON COMPRESS — MAX QUALITY PRO
// MAX QUALITY: H.264 High Profile, CRF 16.
// TIKTOK QUALITY TEST: H.264 High Profile, CRF 17.
// Preserves source resolution and frame rate where supported.

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
      const baseUrl =
        'https://unpkg.com/@ffmpeg/core@0.12.10/dist/esm';

      await ffmpeg.load({
        coreURL: await toBlobURL(
          `${baseUrl}/ffmpeg-core.js`,
          'text/javascript'
        ),
        wasmURL: await toBlobURL(
          `${baseUrl}/ffmpeg-core.wasm`,
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
    throw new Error(
      'Please select an MP4 video. MP4 input is required.'
    );
  }

  const isTikTokTest = mode === 'tiktok';

  const originalName = file.name.replace(/\.[^/.]+$/, '');

  const outputName = isTikTokTest
    ? `${originalName}-neon-tiktok-test.mp4`
    : `${originalName}-neon-max-quality-pro.mp4`;

  const stamp =
    `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  const inputName = `input-${stamp}.mp4`;
  const outputNameInFs = `output-${stamp}.mp4`;

  let ffmpeg;
  let progressHandler;
  let inputWritten = false;
  let outputWritten = false;

  try {
    onProgress(1);

    ffmpeg = await getFFmpeg();

    const fileData = new Uint8Array(
      await file.arrayBuffer().catch(() => {
        throw new Error(
          'FILE_READ_FAILED: The browser could not read the selected video.'
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
        onProgress(
          Math.round(
            Math.max(0, Math.min(1, progress)) * 94 + 4
          )
        );
      }
    };

    ffmpeg.on('progress', progressHandler);

    const args = [
      '-i', inputName,

      '-map', '0:v:0',
      '-map', '0:a?',

      '-c:v', 'libx264',
      '-profile:v', 'high',
      '-preset', isTikTokTest ? 'fast' : 'slow',
      '-crf', isTikTokTest ? '17' : '16',
      '-pix_fmt', 'yuv420p',

      '-fps_mode', 'passthrough',

      '-c:a', 'aac',
      '-b:a', '192k',

      '-map_metadata', '0',
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

    // Mark output for cleanup after successful encoding.
    outputWritten = true;

    const outputData = await ffmpeg.readFile(outputNameInFs);

    if (!(outputData instanceof Uint8Array)) {
      throw new Error('The output video could not be read.');
    }

    if (outputData.length === 0) {
      throw new Error('FFmpeg produced an empty video file.');
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
    console.error('NEON COMPRESS processing error:', error);
    throw error;
  } finally {
    if (ffmpeg && progressHandler) {
      try {
        ffmpeg.off('progress', progressHandler);
      } catch {
        // Ignore progress-listener cleanup errors.
      }
    }

    if (ffmpeg && inputWritten) {
      try {
        await ffmpeg.deleteFile(inputName);
      } catch {
        // Ignore temporary-file cleanup errors.
      }
    }

    if (ffmpeg && outputWritten) {
      try {
        await ffmpeg.deleteFile(outputNameInFs);
      } catch {
        // Ignore temporary-file cleanup errors.
      }
    }
  }
}
