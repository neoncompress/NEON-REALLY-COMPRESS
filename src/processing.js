// NEON COMPRESS processing modes.
// MAX QUALITY: stream-copy original streams.
// TIKTOK QUALITY TEST: H.264 CRF 17, preserving source resolution and frame rate.

import { FFmpeg } from '@ffmpeg/ffmpeg';
import { toBlobURL } from '@ffmpeg/util';

let ffmpegRef = null;

export async function optimizeVideo(file, onProgress = () => {}, mode = 'max') {
  if (!/\.mp4$/i.test(file.name)) {
    throw new Error(
      'Please select an MP4 video. Both modes currently support MP4 input only.'
    );
  }

  const originalName = file.name.replace(/\.[^/.]+$/, '');
  const isTikTokTest = mode === 'tiktok';

  const outputName = isTikTokTest
    ? `${originalName}-neon-tiktok-test.mp4`
    : `${originalName}-neon-max-quality.mp4`;

  const stamp = Date.now();
  const inputName = `input-${stamp}.mp4`;
  const outputNameInFs = `neon-${stamp}.mp4`;

  const ffmpeg = ffmpegRef ?? new FFmpeg();
  ffmpegRef = ffmpeg;

  const onFFmpegProgress = ({ progress }) => {
    if (Number.isFinite(progress)) {
      onProgress(
        Math.max(4, Math.min(96, Math.round(progress * 92)))
      );
    }
  };

  try {
    onProgress(2);

    if (!ffmpeg.loaded) {
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
    }

    ffmpeg.on('progress', onFFmpegProgress);

    const fileData = new Uint8Array(
      await file.arrayBuffer().catch(() => {
        throw new Error(
          'FILE_READ_FAILED: Browser cannot read selected video.'
        );
      })
    );

    await ffmpeg.writeFile(inputName, fileData);

    let args;

    if (isTikTokTest) {
      // TikTok Quality Test: re-encode using H.264.
      args = [
        '-i', inputName,
        '-map', '0:v:0',
        '-map', '0:a?',
        '-c:v', 'libx264',
        '-preset', 'fast',
        '-crf', '17',
        '-pix_fmt', 'yuv420p',
        '-c:a', 'aac',
        '-b:a', '192k',
        '-movflags', '+faststart',
        '-y', outputNameInFs,
      ];
    } else {
      // MAX QUALITY: copy the original video/audio streams.
      args = [
        '-i', inputName,
        '-map', '0:v:0',
        '-map', '0:a?',
        '-c', 'copy',
        '-movflags', '+faststart',
        '-y', outputNameInFs,
      ];
    }

    const exitCode = await ffmpeg.exec(args);

    if (exitCode !== 0) {
      throw new Error(`FFmpeg exited with code ${exitCode}.`);
    }

    const outputData = await ffmpeg.readFile(outputNameInFs);

    if (!(outputData instanceof Uint8Array)) {
      throw new Error('Unexpected binary output.');
    }

    const outputBlob = new Blob(
      [new Uint8Array(outputData)],
      { type: 'video/mp4' }
    );

    if (outputBlob.size === 0) {
      throw new Error('FFmpeg produced an empty MP4.');
    }

    onProgress(100);

    return {
      blob: outputBlob,
      name: outputName,
    };
  } finally {
    ffmpeg.off('progress', onFFmpegProgress);

    try {
      await ffmpeg.deleteFile(inputName);
    } catch {
      // Ignore cleanup errors.
    }

    try {
      await ffmpeg.deleteFile(outputNameInFs);
    } catch {
      // Ignore cleanup errors.
    }
  }
}
