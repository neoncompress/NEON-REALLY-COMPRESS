// NEON COMPRESS V3 — FAST QUALITY + FPS PROCESSOR
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
    // Safer default: no ghost samples; use pc only if the target accepts it.
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
  if (!['pc', 'phone', 'phone-ghost', 'variant-1', 'variant-2', 'variant-3'].includes(postingDevice)) {
    throw new Error('Choose pc, phone, phone-ghost, or variant-1 through variant-3.');
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
