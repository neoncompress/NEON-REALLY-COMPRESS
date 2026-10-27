// NEON COMPRESS V3 — MAX QUALITY + FPS (current CompressBase flow)
// 1) Process every frame locally with the official downscaleVideo pipeline.
//    It verifies frame count/timing, including 60/120 FPS and variable FPS.
// 2) Apply the official CompressBase MP4 metadata patch.
// This takes longer than a metadata-only patch because frames are processed.

let compressBaseModulesPromise = null;

async function getCompressBaseModules() {
  if (!compressBaseModulesPromise) {
    compressBaseModulesPromise = Promise.all([
      import(
        /* @vite-ignore */ 'https://compressbase.com/method-api/downscale.mjs'
      ),
      import(
        /* @vite-ignore */ 'https://compressbase.com/method-api/client.mjs'
      ),
    ]).then(([downscaleModule, clientModule]) => ({
      downscaleVideo: downscaleModule.downscaleVideo,
      patchVideo: clientModule.patchVideo,
    })).catch((error) => {
      compressBaseModulesPromise = null;
      throw error;
    });
  }
  return compressBaseModulesPromise;
}

/**
 * Run the current CompressBase-style Quality + FPS pipeline.
 * The input is processed locally, then its MP4 metadata is patched.
 *
 * @param {File|Blob} file Source video selected by the user.
 * @param {(percent: number) => void} onProgress Optional progress callback.
 * @param {string} mode Kept for compatibility with existing callers.
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
  if (file.size < 16) {
    throw new Error('The selected video file is too small or empty.');
  }
  if (!['variant-1', 'variant-2', 'variant-3'].includes(postingDevice)) {
    throw new Error('Choose variant-1, variant-2, or variant-3.');
  }

  signal?.throwIfAborted();
  onProgress(1);
  onStatus('Loading the Quality + FPS processor…');

  try {
    const { downscaleVideo, patchVideo } = await getCompressBaseModules();
    if (typeof downscaleVideo !== 'function' || typeof patchVideo !== 'function') {
      throw new Error('The CompressBase processing modules did not load correctly.');
    }

    // Unlike the old quick patch, this processes every frame and checks that
    // the original frame count and timestamps—including 60/120 FPS—are kept.
    const processedMp4 = await downscaleVideo(file, {
      signal,
      onStatus: (message) => onStatus(message),
      onProgress: (fraction) => {
        if (Number.isFinite(fraction)) {
          const value = Math.max(0, Math.min(1, fraction));
          onProgress(Math.round(5 + value * 88));
        }
      },
    });

    signal?.throwIfAborted();
    if (!(processedMp4 instanceof Blob) || processedMp4.size < 16) {
      throw new Error('The frame-processing step did not produce a valid MP4.');
    }
    if (processedMp4.size > 8 * 1024 ** 3) {
      throw new Error('The processed MP4 is larger than CompressBase API supports.');
    }

    onProgress(95);
    onStatus('Applying the final Quality + FPS patch…');

    const patchedBlob = await patchVideo(processedMp4, {
      postingDevice,
      signal,
      onStatus: (message) => {
        onStatus(message);
        onProgress(98);
      },
    });

    if (!(patchedBlob instanceof Blob) || patchedBlob.size < 16) {
      throw new Error('The final patched video is empty or invalid.');
    }

    const sourceName = file.name || 'video';
    const originalName = sourceName.replace(/\.[^/.]+$/, '');
    const suffix = mode === 'tiktok' ? '-neon-tiktok-quality-fps' : '-neon-quality-fps';

    onProgress(100);
    onStatus('Done. Check the downloaded MP4, then upload it to TikTok Web.');
    return {
      blob: patchedBlob,
      name: `${originalName}${suffix}.mp4`,
    };
  } catch (error) {
    console.error('NEON COMPRESS processing error:', error);
    throw error;
  }
}
