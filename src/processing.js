// NEON COMPRESS V3 — MP4 REPAIR PROCESSOR
// Preserves encoded video/audio streams using stream copy.
// Adds timeouts, MP4 remuxing and output-duration validation.

let compressBaseModulePromise = null;
let ffmpegModulePromise = null;
let ffmpegInstancePromise = null;

const MAX_FILE_SIZE = 8 * 1024 ** 3;
const ENGINE_TIMEOUT = 120000;
const REMUX_TIMEOUT = 120000;

async function getCompressBase() {
  if (!compressBaseModulePromise) {
    compressBaseModulePromise = import(
      /* @vite-ignore */ 'https://compressbase.com/method-api/client.mjs'
    ).catch((error) => {
      compressBaseModulePromise = null;
      throw error;
    });
  }

  return compressBaseModulePromise;
}

async function getFFmpegModules() {
  if (!ffmpegModulePromise) {
    ffmpegModulePromise = Promise.all([
      import(
        /* @vite-ignore */ 'https://unpkg.com/@ffmpeg/ffmpeg@0.12.10/dist/esm/index.js'
      ),
      import(
        /* @vite-ignore */ 'https://unpkg.com/@ffmpeg/util@0.12.2/dist/esm/index.js'
      )
    ]).catch((error) => {
      ffmpegModulePromise = null;
      throw error;
    });
  }

  return ffmpegModulePromise;
}

function throwIfAborted(signal) {
  if (signal?.aborted) {
    throw new DOMException(
      'The operation was aborted.',
      'AbortError'
    );
  }
}

function withTimeout(
  promise,
  timeoutMs,
  label,
  onTimeout = () => {}
) {
  let timer;

  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      try {
        onTimeout();
      } catch {}

      reject(
        new Error(
          `${label} timed out after ${Math.round(timeoutMs / 1000)} seconds.`
        )
      );
    }, timeoutMs);
  });

  return Promise.race([promise, timeout]).finally(() => {
    clearTimeout(timer);
  });
}

async function getFFmpeg(onStatus = () => {}) {
  if (!ffmpegInstancePromise) {
    ffmpegInstancePromise = (async () => {
      const [{ FFmpeg }, { toBlobURL }] =
        await getFFmpegModules();

      const ffmpeg = new FFmpeg();

      ffmpeg.on('log', ({ message }) => {
        console.debug('[NEON COMPRESS FFmpeg]', message);
      });

      const packageURL =
        'https://unpkg.com/@ffmpeg/ffmpeg@0.12.10/dist/esm';

      const coreURLBase =
        'https://unpkg.com/@ffmpeg/core@0.12.10/dist/umd';

      onStatus('Loading FFmpeg worker…');

      const classWorkerURL = await toBlobURL(
        `${packageURL}/worker.js`,
        'text/javascript'
      );

      const coreURL = await toBlobURL(
        `${coreURLBase}/ffmpeg-core.js`,
        'text/javascript'
      );

      const wasmURL = await toBlobURL(
        `${coreURLBase}/ffmpeg-core.wasm`,
        'application/wasm'
      );

      onStatus('Starting FFmpeg engine…');

      await ffmpeg.load({
        classWorkerURL,
        coreURL,
        wasmURL
      });

      return ffmpeg;
    })().catch((error) => {
      ffmpegInstancePromise = null;
      throw error;
    });
  }

  return ffmpegInstancePromise;
}

function getInputExtension(file) {
  const match = String(file?.name || '').match(
    /\.([a-z0-9]{1,8})$/i
  );

  return match ? match[1].toLowerCase() : 'mp4';
}

async function getVideoDuration(blob) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const video = document.createElement('video');

    let finished = false;

    function cleanup() {
      if (finished) return;

      finished = true;
      video.removeAttribute('src');
      video.load();
      URL.revokeObjectURL(url);
    }

    const timer = setTimeout(() => {
      cleanup();

      reject(
        new Error(
          'Timed out while reading MP4 duration.'
        )
      );
    }, 15000);

    video.preload = 'metadata';

    video.onloadedmetadata = () => {
      clearTimeout(timer);

      const duration = video.duration;
      cleanup();

      if (
        !Number.isFinite(duration) ||
        duration <= 0
      ) {
        reject(
          new Error(
            'The MP4 duration is invalid.'
          )
        );
        return;
      }

      resolve(duration);
    };

    video.onerror = () => {
      clearTimeout(timer);
      cleanup();

      reject(
        new Error(
          'The browser cannot read the MP4 metadata.'
        )
      );
    };

    video.src = url;
  });
}

async function remuxMP4(
  inputBlob,
  signal,
  onStatus = () => {}
) {
  throwIfAborted(signal);

  onStatus('Loading MP4 repair engine…');

  const ffmpeg = await withTimeout(
    getFFmpeg(onStatus),
    ENGINE_TIMEOUT,
    'FFmpeg engine loading',
    () => {
      try {
        ffmpegInstancePromise = null;
      } catch {}
    }
  );

  throwIfAborted(signal);

  const inputName =
    `neon_input.${getInputExtension(inputBlob)}`;

  const outputName = 'neoncompress_repaired.mp4';

  try {
    onStatus('Preparing video data…');

    const inputBytes = new Uint8Array(
      await inputBlob.arrayBuffer()
    );

    throwIfAborted(signal);

    await ffmpeg.writeFile(
      inputName,
      inputBytes
    );

    onStatus(
      'Rebuilding MP4 container and timestamps…'
    );

    await withTimeout(
      ffmpeg.exec([
        '-y',
        '-fflags',
        '+genpts',
        '-i',
        inputName,
        '-map',
        '0:v:0',
        '-map',
        '0:a?',
        '-c',
        'copy',
        '-avoid_negative_ts',
        'make_zero',
        '-movflags',
        '+faststart',
        outputName
      ]),
      REMUX_TIMEOUT,
      'MP4 remux',
      () => {
        try {
          ffmpeg.terminate();
        } catch {}

        ffmpegInstancePromise = null;
      }
    );

    throwIfAborted(signal);

    onStatus('Reading repaired video…');

    const outputData = await ffmpeg.readFile(
      outputName
    );

    const outputBlob = new Blob(
      [outputData],
      { type: 'video/mp4' }
    );

    if (outputBlob.size === 0) {
      throw new Error(
        'MP4 repair produced an empty file.'
      );
    }

    return outputBlob;
  } finally {
    try {
      await ffmpeg.deleteFile(inputName);
    } catch {}

    try {
      await ffmpeg.deleteFile(outputName);
    } catch {}
  }
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

  if (
    !file ||
    typeof file.slice !== 'function' ||
    typeof file.size !== 'number'
  ) {
    throw new Error(
      'Please select a valid video file.'
    );
  }

  if (
    file.name &&
    !/\.mp4$/i.test(file.name)
  ) {
    throw new Error(
      'Please select an MP4 video.'
    );
  }

  if (file.size < 16) {
    throw new Error(
      'The selected video file is too small or empty.'
    );
  }

  if (file.size > MAX_FILE_SIZE) {
    throw new Error(
      'NEON COMPRESS supports MP4 files up to 8 GiB.'
    );
  }

  if (
    ![
      'variant-1',
      'variant-2',
      'variant-3'
    ].includes(postingDevice)
  ) {
    throw new Error(
      'Choose variant-1, variant-2, or variant-3.'
    );
  }

  throwIfAborted(signal);

  onProgress(3);
  onStatus('Preparing video…');

  try {
    const { patchVideo } = await getCompressBase();

    throwIfAborted(signal);

    onProgress(12);
    onStatus('Applying video patch…');

    const patchedBlob = await patchVideo(file, {
      postingDevice,
      signal,

      onStatus: (message) => {
        onStatus(message);
        onProgress(35);
      }
    });

    if (
      !(patchedBlob instanceof Blob) ||
      patchedBlob.size === 0
    ) {
      throw new Error(
        'The patch processor returned an invalid video.'
      );
    }

    throwIfAborted(signal);

    onProgress(42);
    onStatus('Checking patched MP4 metadata…');

    let patchedDuration = null;

    try {
      patchedDuration = await getVideoDuration(
        patchedBlob
      );

      onStatus(
        `Detected duration: ${patchedDuration.toFixed(2)} seconds.`
      );
    } catch (error) {
      console.warn(
        '[NEON COMPRESS] Patched metadata check failed:',
        error
      );

      onStatus(
        'Metadata is unreadable; attempting container repair…'
      );
    }

    throwIfAborted(signal);

    onProgress(48);

    const repairedBlob = await remuxMP4(
      patchedBlob,
      signal,
      onStatus
    );

    throwIfAborted(signal);

    onStatus('Verifying repaired MP4 duration…');

    const repairedDuration = await getVideoDuration(
      repairedBlob
    );

    if (
      patchedDuration !== null &&
      repairedDuration >
        Math.max(
          patchedDuration * 3,
          patchedDuration + 10
        )
    ) {
      throw new Error(
        'The repaired duration does not match the patched video duration.'
      );
    }

    onProgress(100);

    onStatus(
      `Done. Repaired MP4 duration: ${repairedDuration.toFixed(2)} seconds.`
    );

    return {
      blob: repairedBlob,
      name: 'neoncompress.mp4'
    };
  } catch (error) {
    console.error(
      '[NEON COMPRESS] Processing failed:',
      error
    );

    throw error;
  }
}
