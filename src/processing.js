// NEON COMPRESS V3 — MP4 CONTAINER REPAIR
// Keeps the video/audio streams unchanged (stream copy; no re-encoding).
// After the CompressBase patch, remuxes the MP4 to normalize the container,
// timestamps, and fast-start metadata for better player compatibility.
//
// NOTE: Stream-copy remuxing preserves the encoded picture/audio and FPS.
// It cannot repair every possible corrupt source file or guarantee TikTok acceptance.

let compressBaseModulePromise = null;
let ffmpegModulePromise = null;
let ffmpegInstancePromise = null;

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
      import(/* @vite-ignore */ 'https://unpkg.com/@ffmpeg/ffmpeg@0.12.10/dist/esm/index.js'),
      import(/* @vite-ignore */ 'https://unpkg.com/@ffmpeg/util@0.12.2/dist/esm/index.js')
    ]).catch((error) => {
      ffmpegModulePromise = null;
      throw error;
    });
  }
  return ffmpegModulePromise;
}

async function getFFmpeg(onStatus = () => {}) {
  if (!ffmpegInstancePromise) {
    ffmpegInstancePromise = (async () => {
      const [{ FFmpeg }, { toBlobURL }] = await getFFmpegModules();
      const ffmpeg = new FFmpeg();

      ffmpeg.on('log', ({ message }) => {
        // Keep logs available for debugging without flooding the UI.
        console.debug('[NEON COMPRESS FFmpeg]', message);
      });

      ffmpeg.on('progress', ({ progress }) => {
        if (Number.isFinite(progress)) {
          onStatus(`Repairing MP4 container… ${Math.max(0, Math.min(99, Math.round(progress * 100)))}%`);
        }
      });

      const baseURL = 'https://unpkg.com/@ffmpeg/core@0.12.10/dist/umd';
      const coreURL = await toBlobURL(`${baseURL}/ffmpeg-core.js`, 'text/javascript');
      const wasmURL = await toBlobURL(`${baseURL}/ffmpeg-core.wasm`, 'application/wasm');

      const ffmpegBaseURL =
  'https://unpkg.com/@ffmpeg/ffmpeg@0.12.10/dist/esm';

const classWorkerURL = await toBlobURL(
  `${ffmpegBaseURL}/worker.js`,
  'text/javascript'
);

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

function throwIfAborted(signal) {
  if (signal?.aborted) {
    throw new DOMException('The operation was aborted.', 'AbortError');
  }
}

function safeInputExtension(file) {
  const name = typeof file?.name === 'string' ? file.name : '';
  const match = name.match(/\.([a-z0-9]{1,8})$/i);
  return match ? match[1].toLowerCase() : 'mp4';
}

async function getVideoDuration(blob) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const video = document.createElement('video');
    let finished = false;

    const cleanup = () => {
      if (finished) return;
      finished = true;
      video.removeAttribute('src');
      video.load();
      URL.revokeObjectURL(url);
    };

    const timer = setTimeout(() => {
      cleanup();
      reject(new Error('Timed out while checking the output video duration.'));
    }, 15000);

    video.preload = 'metadata';
    video.onloadedmetadata = () => {
      clearTimeout(timer);
      const duration = video.duration;
      cleanup();
      if (!Number.isFinite(duration) || duration <= 0) {
        reject(new Error('The output MP4 has an invalid or unreadable duration.'));
      } else {
        resolve(duration);
      }
    };
    video.onerror = () => {
      clearTimeout(timer);
      cleanup();
      reject(new Error('The browser cannot read the output MP4 metadata.'));
    };
    video.src = url;
  });
}

async function remuxMP4(inputBlob, signal, onStatus = () => {}) {
  throwIfAborted(signal);
  onStatus('Loading MP4 repair engine…');

  const ffmpeg = await getFFmpeg(onStatus);
  throwIfAborted(signal);

  const inputName = `neon_input.${safeInputExtension(inputBlob)}`;
  const outputName = 'neoncompress_repaired.mp4';

  try {
    const inputBytes = new Uint8Array(await inputBlob.arrayBuffer());
    throwIfAborted(signal);
    await ffmpeg.writeFile(inputName, inputBytes);

    onStatus('Rebuilding MP4 container and timestamps…');

    // Stream copy: do not decode/re-encode the video or audio.
    await ffmpeg.exec([
      '-y',
      '-fflags', '+genpts',
      '-i', inputName,
      '-map', '0:v:0',
      '-map', '0:a?',
      '-c', 'copy',
      '-avoid_negative_ts', 'make_zero',
      '-movflags', '+faststart',
      outputName
    ]);

    throwIfAborted(signal);
    const outputData = await ffmpeg.readFile(outputName);
    const outputBlob = new Blob([outputData], { type: 'video/mp4' });

    if (!outputBlob.size) {
      throw new Error('MP4 repair produced an empty output file.');
    }

    return outputBlob;
  } finally {
    // Best-effort cleanup of FFmpeg's virtual filesystem.
    try { await ffmpeg.deleteFile(inputName); } catch {}
    try { await ffmpeg.deleteFile(outputName); } catch {}
  }
}

/**
 * Optimize and repair an MP4.
 *
 * @param {File|Blob} file
 * @param {(percent: number) => void} onProgress
 * @param {string} mode
 * @param {{ postingDevice?: string, signal?: AbortSignal,
 *   onStatus?: (message: string) => void }} options
 * @returns {Promise<{ blob: Blob, name: string }>}
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
    throw new Error('NEON COMPRESS supports MP4 files up to 8 GiB.');
  }
  if (!['variant-1', 'variant-2', 'variant-3'].includes(postingDevice)) {
    throw new Error('Choose variant-1, variant-2, or variant-3.');
  }

  throwIfAborted(signal);
  onProgress(3);
  onStatus('Preparing video…');

  try {
    const { patchVideo } = await getCompressBase();
    throwIfAborted(signal);

    onProgress(12);
    onStatus('Applying the selected video patch…');

    const patchedBlob = await patchVideo(file, {
      postingDevice,
      signal,
      onStatus: (message) => {
        onStatus(message);
        onProgress(35);
      }
    });

    if (!(patchedBlob instanceof Blob) || patchedBlob.size === 0) {
      throw new Error('The patch processor returned an empty or invalid video.');
    }

    throwIfAborted(signal);
    onProgress(42);
    onStatus('Checking patched MP4 metadata…');

    // Try reading the patched file's duration. Even if the browser can read it,
    // remux below is still used to normalize the MP4 container/timestamps.
    let originalDuration = null;
    try {
      originalDuration = await getVideoDuration(patchedBlob);
      onStatus(`Detected video duration: ${originalDuration.toFixed(2)} seconds.`);
    } catch (error) {
      console.warn('[NEON COMPRESS] Patched MP4 metadata check:', error);
      onStatus('Patched metadata is unreadable; attempting MP4 container repair…');
    }

    throwIfAborted(signal);
    onProgress(48);

    const repairedBlob = await remuxMP4(patchedBlob, signal, (message) => {
      onStatus(message);
    });

    throwIfAborted(signal);
    onStatus('Verifying repaired MP4 duration…');
    const repairedDuration = await getVideoDuration(repairedBlob);

    // A 2-second source should not become a many-minute/hour output.
    // This catches gross timestamp/container errors without rejecting small
    // duration rounding differences.
    if (
      originalDuration !== null &&
      repairedDuration > Math.max(originalDuration * 3, originalDuration + 10)
    ) {
      throw new Error(
        `The repaired duration (${repairedDuration.toFixed(2)} s) does not match ` +
        `the patched duration (${originalDuration.toFixed(2)} s). Please try the original MP4.`
      );
    }

    onProgress(100);
    onStatus(`Done. MP4 container repaired; duration ${repairedDuration.toFixed(2)} seconds.`);

    return {
      blob: repairedBlob,
      name: 'neoncompress.mp4'
    };
  } catch (error) {
    console.error('[NEON COMPRESS] Processing failed:', error);
    throw error;
  }
}
