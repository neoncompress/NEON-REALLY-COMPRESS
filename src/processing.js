// NEON COMPRESS V3 — QUALITY + FPS PROCESSOR
// Pipeline:
// Original MP4 → downscaleVideo() → patchVideo() → Download MP4
//
// Uses CompressBase browser modules.
// Attempts to preserve source FPS, including 60/120 FPS.
// TikTok may still re-encode uploaded videos.

let compressBaseModulesPromise = null;

async function getCompressBaseModules() {
  if (!compressBaseModulesPromise) {
    compressBaseModulesPromise = Promise.all([
      import(
        /* @vite-ignore */
        'https://compressbase.com/method-api/downscale.mjs'
      ),
      import(
        /* @vite-ignore */
        'https://compressbase.com/method-api/client.mjs'
      )
    ]).then(([downscaleModule, patchModule]) => ({
      downscaleVideo: downscaleModule.downscaleVideo,
      patchVideo: patchModule.patchVideo
    })).catch(error => {
      compressBaseModulesPromise = null;
      throw error;
    });
  }

  return compressBaseModulesPromise;
}

/**
 * NEON COMPRESS V3
 *
 * @param {File|Blob} file
 * @param {(percent:number)=>void} onProgress
 * @param {string} mode
 * @param {{
 *   postingDevice?:string,
 *   signal?:AbortSignal,
 *   onStatus?:(message:string)=>void
 * }} options
 *
 * @returns {Promise<{blob:Blob,name:string}>}
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
    onStatus = () => {}
  } = options ?? {};

  // Validate video
  if (
    !file ||
    typeof file.slice !== 'function' ||
    typeof file.size !== 'number'
  ) {
    throw new Error('Please select a valid video file.');
  }

  if (file.name && !/\.mp4$/i.test(file.name)) {
    throw new Error('Please select an MP4 video.');
  }

  if (file.size < 16) {
    throw new Error('The selected video file is empty.');
  }

  if (![
    'variant-1',
    'variant-2',
    'variant-3'
  ].includes(postingDevice)) {
    throw new Error('Invalid processing variant.');
  }

  signal?.throwIfAborted();

  onProgress(2);
  onStatus('Loading Quality + FPS processor…');

  try {

    const {
      downscaleVideo,
      patchVideo
    } = await getCompressBaseModules();

    signal?.throwIfAborted();

    // STEP 1
    // Process video frames and preserve source FPS where supported.

    onStatus('Processing video quality and FPS…');

    const processedMp4 = await downscaleVideo(file, {

      signal,

      onStatus,

      onProgress: fraction => {

        const safeFraction = Math.max(
          0,
          Math.min(1, Number(fraction) || 0)
        );

        onProgress(
          Math.round(safeFraction * 90)
        );

      }

    });

    signal?.throwIfAborted();

    if (
      !(processedMp4 instanceof Blob) ||
      processedMp4.size === 0
    ) {
      throw new Error('Video processing returned an empty file.');
    }

    // STEP 2
    // Apply CompressBase MP4 patch.

    onProgress(92);
    onStatus('Applying Quality + FPS MP4 patch…');

    const patchedBlob = await patchVideo(processedMp4, {

      postingDevice,

      signal,

      onStatus

    });

    signal?.throwIfAborted();

    if (
      !(patchedBlob instanceof Blob) ||
      patchedBlob.size === 0
    ) {
      throw new Error('MP4 patch returned an empty file.');
    }

    // STEP 3
    // Prepare final download.

    const sourceName = file.name || 'video.mp4';

    const originalName = sourceName.replace(/\.mp4$/i, '');

    const suffix =
      mode === 'tiktok'
        ? '-neon-tiktok-quality-fps'
        : '-neon-quality-fps';

    onProgress(100);

    onStatus(
      'Processing complete. Download your MP4.'
    );

    return {

      blob: patchedBlob,

      name: `${originalName}${suffix}.mp4`

    };

  } catch (error) {

    console.error(
      'NEON COMPRESS V3 processing error:',
      error
    );

    throw error;

  }

}
