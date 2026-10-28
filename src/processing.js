// NEON COMPRESS V3
// MAX QUALITY: patch the original MP4 without downscaleVideo.
// TIKTOK QUALITY TEST: downscaleVideo first, then patchVideo.
//
// Important: FPS preservation depends on the external modules.
// TikTok may also transcode the uploaded video.

let modulesPromise = null;

async function getModules() {
  if (!modulesPromise) {
    modulesPromise = Promise.all([
      import(
        /* @vite-ignore */
        'https://compressbase.com/method-api/downscale.mjs'
      ),
      import(
        /* @vite-ignore */
        'https://compressbase.com/method-api/client.mjs'
      )
    ])
      .then(([downscaleModule, clientModule]) => {
        if (typeof downscaleModule.downscaleVideo !== 'function') {
          throw new Error('downscaleVideo() is unavailable.');
        }

        if (typeof clientModule.patchVideo !== 'function') {
          throw new Error('patchVideo() is unavailable.');
        }

        return {
          downscaleVideo: downscaleModule.downscaleVideo,
          patchVideo: clientModule.patchVideo
        };
      })
      .catch(error => {
        modulesPromise = null;
        throw error;
      });
  }

  return modulesPromise;
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

  if (!['variant-1', 'variant-2', 'variant-3'].includes(postingDevice)) {
    throw new Error('Invalid posting device.');
  }

  if (!['max', 'tiktok'].includes(mode)) {
    throw new Error('Invalid processing mode.');
  }

  signal?.throwIfAborted();

  onProgress(3);
  onStatus('Loading video processing modules…');

  const { downscaleVideo, patchVideo } = await getModules();

  signal?.throwIfAborted();

  let inputForPatch = file;

  if (mode === 'tiktok') {
    onStatus('Running TikTok quality processing…');

    inputForPatch = await downscaleVideo(file, {
      signal,
      onStatus,
      onProgress: fraction => {
        const value = Number(fraction);

        if (Number.isFinite(value)) {
          onProgress(
            Math.round(Math.max(0, Math.min(1, value)) * 80)
          );
        }
      }
    });

    signal?.throwIfAborted();

    if (!(inputForPatch instanceof Blob) || inputForPatch.size < 16) {
      throw new Error('Video processing returned an invalid file.');
    }
  } else {
    onProgress(25);
    onStatus('MAX QUALITY: preparing the original MP4 without downscaling…');
  }

  signal?.throwIfAborted();

  onStatus('Applying MP4 preparation…');

  const outputBlob = await patchVideo(inputForPatch, {
    postingDevice,
    signal,
    onStatus
  });

  signal?.throwIfAborted();

  if (!(outputBlob instanceof Blob) || outputBlob.size < 16) {
    throw new Error('MP4 preparation returned an invalid file.');
  }

  const originalName = (file.name || 'video.mp4')
    .replace(/\.mp4$/i, '');

  const suffix = mode === 'tiktok'
    ? '-neon-tiktok-quality-fps'
    : '-neon-quality-fps';

  onProgress(100);
  onStatus('Finished. Check the output FPS before uploading to TikTok.');

  return {
    blob: outputBlob,
    name: `${originalName}${suffix}.mp4`
  };
}
