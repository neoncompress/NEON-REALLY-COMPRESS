// NEON COMPRESS V3
// MAX QUALITY + FPS
//
// MAX QUALITY:
//   - Does NOT call downscaleVideo().
//   - Sends the original MP4 directly to patchVideo().
//   - Avoids an additional video re-encoding stage.
//
// TIKTOK QUALITY TEST:
//   - Runs downscaleVideo(), then patchVideo().
//
// IMPORTANT:
//   TikTok may transcode uploaded videos.
//   Final TikTok FPS, codec, resolution and file size
//   cannot be guaranteed by this processor alone.

let clientModulePromise = null;
let allModulesPromise = null;

async function getClientModule() {
  if (!clientModulePromise) {
    clientModulePromise = import(
      /* @vite-ignore */
      'https://compressbase.com/method-api/client.mjs'
    )
      .then(module => {
        if (typeof module.patchVideo !== 'function') {
          throw new Error(
            'CompressBase patchVideo() is unavailable.'
          );
        }

        return module;
      })
      .catch(error => {
        clientModulePromise = null;
        throw error;
      });
  }

  return clientModulePromise;
}

async function getAllModules() {
  if (!allModulesPromise) {
    allModulesPromise = Promise.all([
      import(
        /* @vite-ignore */
        'https://compressbase.com/method-api/downscale.mjs'
      ),
      getClientModule()
    ])
      .then(([downscaleModule, clientModule]) => {
        if (typeof downscaleModule.downscaleVideo !== 'function') {
          throw new Error(
            'CompressBase downscaleVideo() is unavailable.'
          );
        }

        return {
          downscaleVideo: downscaleModule.downscaleVideo,
          patchVideo: clientModule.patchVideo
        };
      })
      .catch(error => {
        allModulesPromise = null;
        throw error;
      });
  }

  return allModulesPromise;
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
    onStatus = () => {}
  } = options ?? {};

  if (!(file instanceof Blob) || file.size < 16) {
    throw new Error('Invalid or empty video file.');
  }

  if (!/\.mp4$/i.test(file.name || '')) {
    throw new Error('Please select an MP4 video.');
  }

  if (file.size > 8 * 1024 * 1024 * 1024) {
    throw new Error('Video exceeds the 8 GiB limit.');
  }

  if (!['max', 'tiktok'].includes(mode)) {
    throw new Error('Invalid processing mode.');
  }

  if (!['variant-1', 'variant-2', 'variant-3'].includes(
    postingDevice
  )) {
    throw new Error('Invalid posting device.');
  }

  signal?.throwIfAborted();

  const originalName = file.name.replace(/\.mp4$/i, '');

  let inputForPatch = file;
  let patchVideo;

  // MAX QUALITY:
  // Skip downscaleVideo completely.
  if (mode === 'max') {
    onProgress(10);
    onStatus(
      'MAX QUALITY: preparing the original MP4 without downscaling…'
    );

    const clientModule = await getClientModule();
    patchVideo = clientModule.patchVideo;

    onProgress(25);
  } else {
    // TIKTOK QUALITY TEST:
    // Run the external downscale pipeline first.
    onProgress(5);
    onStatus('Loading video processing modules…');

    const modules = await getAllModules();

    patchVideo = modules.patchVideo;

    signal?.throwIfAborted();

    onStatus('Running TikTok quality processing…');

    inputForPatch = await modules.downscaleVideo(file, {
      signal,
      onStatus,
      onProgress: fraction => {
        const value = Number(fraction);

        if (Number.isFinite(value)) {
          onProgress(
            Math.round(
              Math.max(0, Math.min(1, value)) * 75
            )
          );
        }
      }
    });

    signal?.throwIfAborted();

    if (
      !(inputForPatch instanceof Blob) ||
      inputForPatch.size < 16
    ) {
      throw new Error(
        'Video processing returned an invalid file.'
      );
    }
  }

  signal?.throwIfAborted();

  onStatus(
    mode === 'max'
      ? 'Preparing original video stream…'
      : 'Applying MP4 preparation…'
  );

  const outputBlob = await patchVideo(inputForPatch, {
    postingDevice,
    signal,
    onStatus
  });

  signal?.throwIfAborted();

  if (!(outputBlob instanceof Blob) || outputBlob.size < 16) {
    throw new Error(
      'MP4 preparation returned an invalid file.'
    );
  }

  onProgress(100);

  onStatus(
    'Finished. Verify the output FPS before uploading to TikTok.'
  );

  const suffix = mode === 'max'
    ? '-neon-quality-fps'
    : '-neon-tiktok-quality-fps';

  return {
    blob: outputBlob,
    name: `${originalName}${suffix}.mp4`
  };
}
