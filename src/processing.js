// ZILEM METHOD — 1080p60 PROCESSING JS
// Paste this module into the site's Processing JS field if it accepts ES modules.
// Pipeline: encode to 1080x1920 / 60 fps in the browser with FFmpeg.wasm, then
// apply CompressBase's MP4 patch and remove its exact metadata comment.
// NOTE: 30 fps source -> 60 fps output means duplicated frames, not new motion.
// TikTok may re-encode the upload and can still change the delivered frame rate.

let ffmpegPromise = null;
let ffmpegClassWorkerURL = null;
let compressBaseModulePromise = null;

const FFMPEG_PACKAGE_BASE =
  'https://cdn.jsdelivr.net/npm/@ffmpeg/ffmpeg@0.12.15/dist/esm';
const FFMPEG_JS_URL = `${FFMPEG_PACKAGE_BASE}/index.js`;
const FFMPEG_UTIL_URL =
  'https://cdn.jsdelivr.net/npm/@ffmpeg/util@0.12.2/dist/esm/index.js';
const FFMPEG_CORE_BASE =
  'https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.10/dist/esm';

function checkAbort(signal) {
  if (signal?.aborted) {
    throw new DOMException('Processing cancelled.', 'AbortError');
  }
}

async function getFFmpeg(onStatus = () => {}) {
  if (!ffmpegPromise) {
    ffmpegPromise = (async () => {
      onStatus('1080p60 processor татаж байна (~31 MB)…');

      const [ffmpegModule, utilModule] = await Promise.all([
        import(/* @vite-ignore */ FFMPEG_JS_URL),
        import(/* @vite-ignore */ FFMPEG_UTIL_URL),
      ]);

      const { FFmpeg } = ffmpegModule;
      const { toBlobURL } = utilModule;
      if (!FFmpeg || !toBlobURL) {
        throw new Error('FFmpeg.wasm module ачаалж чадсангүй.');
      }

      const ffmpeg = new FFmpeg();
      // FFmpeg's default worker.js URL points back to the CDN, which browsers
      // reject when this page is hosted on another origin. Fetch the worker,
      // point its two static imports back to the CDN, then serve it as a blob.
      const workerResponse = await fetch(`${FFMPEG_PACKAGE_BASE}/worker.js`);
      if (!workerResponse.ok) {
        throw new Error(`FFmpeg worker татаж чадсангүй (${workerResponse.status}).`);
      }
      let workerCode = await workerResponse.text();
      workerCode = workerCode
        .replaceAll('"./const.js"', `"${FFMPEG_PACKAGE_BASE}/const.js"`)
        .replaceAll('"./errors.js"', `"${FFMPEG_PACKAGE_BASE}/errors.js"`);
      if (workerCode.includes('"./const.js"') || workerCode.includes('"./errors.js"')) {
        throw new Error('FFmpeg worker import замыг шинэчилж чадсангүй.');
      }
      ffmpegClassWorkerURL = URL.createObjectURL(
        new Blob([workerCode], { type: 'text/javascript' })
      );

      const coreURL = await toBlobURL(
        `${FFMPEG_CORE_BASE}/ffmpeg-core.js`,
        'text/javascript'
      );
      const wasmURL = await toBlobURL(
        `${FFMPEG_CORE_BASE}/ffmpeg-core.wasm`,
        'application/wasm'
      );

      onStatus('FFmpeg.wasm эхлүүлж байна…');
      await ffmpeg.load({ classWorkerURL: ffmpegClassWorkerURL, coreURL, wasmURL });
      return ffmpeg;
    })().catch((error) => {
      if (ffmpegClassWorkerURL) {
        URL.revokeObjectURL(ffmpegClassWorkerURL);
        ffmpegClassWorkerURL = null;
      }
      ffmpegPromise = null;
      throw error;
    });
  }
  return ffmpegPromise;
}

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

/**
 * Remove only the exact CompressBase marker from the MP4 moov atom.
 * The marker is blanked without changing atom sizes or media samples.
 */
export async function removeCompressBaseComment(file, signal) {
  const marker = new TextEncoder().encode('Patched by Compressbase');
  const chunkSize = 1024 * 1024;
  let offset = 0;
  let moovStart = -1;
  let moovEnd = -1;
  let moovHeaderSize = 8;

  while (offset + 8 <= file.size) {
    checkAbort(signal);
    const headerBytes = new Uint8Array(
      await file.slice(offset, offset + 16).arrayBuffer()
    );
    if (headerBytes.length < 8) break;

    const view = new DataView(
      headerBytes.buffer,
      headerBytes.byteOffset,
      headerBytes.byteLength
    );
    let atomSize = view.getUint32(0);
    const atomType = String.fromCharCode(
      headerBytes[4], headerBytes[5], headerBytes[6], headerBytes[7]
    );
    let headerSize = 8;

    if (atomSize === 1) {
      if (headerBytes.length < 16) {
        throw new Error('MP4 atom header မပြည့်စုံပါ။');
      }
      const extendedSize = view.getBigUint64(8);
      if (extendedSize > BigInt(Number.MAX_SAFE_INTEGER)) {
        throw new Error('MP4 metadata အရွယ်အစား အလွန်ကြီးနေပါသည်။');
      }
      atomSize = Number(extendedSize);
      headerSize = 16;
    } else if (atomSize === 0) {
      atomSize = file.size - offset;
    }

    if (atomSize < headerSize || offset + atomSize > file.size) {
      throw new Error('MP4 atom бүтэц буруу тул metadata-г өөрчилсөнгүй.');
    }

    if (atomType === 'moov') {
      moovStart = offset;
      moovEnd = offset + atomSize;
      moovHeaderSize = headerSize;
      break;
    }
    offset += atomSize;
  }

  if (moovStart < 0) {
    throw new Error('MP4 metadata (moov atom) олдсонгүй.');
  }

  const searchStart = moovStart + moovHeaderSize;
  const foundOffsets = [];
  let scanStart = searchStart;

  while (scanStart < moovEnd) {
    checkAbort(signal);
    const ownedEnd = Math.min(scanStart + chunkSize, moovEnd);
    const readEnd = Math.min(ownedEnd + marker.length - 1, moovEnd);
    const bytes = new Uint8Array(
      await file.slice(scanStart, readEnd).arrayBuffer()
    );

    for (let i = 0; i <= bytes.length - marker.length; i += 1) {
      if (scanStart + i >= ownedEnd) break;
      let match = true;
      for (let j = 0; j < marker.length; j += 1) {
        if (bytes[i + j] !== marker[j]) {
          match = false;
          break;
        }
      }
      if (match) foundOffsets.push(scanStart + i);
    }
    scanStart = ownedEnd;
  }

  if (foundOffsets.length === 0) {
    return { blob: file, removedCount: 0 };
  }

  const parts = [];
  let copyFrom = 0;
  const blank = new Uint8Array(marker.length);
  for (const found of foundOffsets) {
    parts.push(file.slice(copyFrom, found), blank);
    copyFrom = found + marker.length;
  }
  parts.push(file.slice(copyFrom));

  return {
    blob: new Blob(parts, { type: 'video/mp4' }),
    removedCount: foundOffsets.length,
  };
}

async function encode1080p60(file, onProgress, onStatus, signal) {
  const ffmpeg = await getFFmpeg(onStatus);
  checkAbort(signal);

  const id = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const inputName = `zilem-input-${id}.mp4`;
  const outputName = `zilem-output-${id}.mp4`;
  let progressHandler;
  let abortHandler;

  try {
    onStatus('မူရင်းဗီဒီယိုကို 1080p60 အဖြစ် encode လုပ်နေသည်…');
    onProgress(10);

    const inputBytes = new Uint8Array(await file.arrayBuffer());
    checkAbort(signal);
    await ffmpeg.writeFile(inputName, inputBytes);

    progressHandler = ({ progress }) => {
      if (Number.isFinite(progress)) {
        const percent = Math.max(0, Math.min(1, progress));
        onProgress(Math.round(12 + percent * 68));
      }
    };
    ffmpeg.on('progress', progressHandler);

    // If the user cancels during the WASM encode, terminate that FFmpeg worker.
    abortHandler = () => {
      try {
        ffmpeg.terminate();
      } finally {
        if (ffmpegClassWorkerURL) {
          URL.revokeObjectURL(ffmpegClassWorkerURL);
          ffmpegClassWorkerURL = null;
        }
        ffmpegPromise = null;
      }
    };
    signal?.addEventListener('abort', abortHandler, { once: true });

    await ffmpeg.exec([
      '-i', inputName,
      '-map', '0:v:0',
      '-map', '0:a?',
      '-map_metadata', '0',
      '-vf',
      'scale=1080:1920:force_original_aspect_ratio=decrease:force_divisible_by=2:flags=lanczos,pad=1080:1920:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1,fps=60',
      '-c:v', 'libx264',
      '-preset', 'veryfast',
      '-crf', '18',
      '-profile:v', 'high',
      '-level:v', '4.2',
      '-pix_fmt', 'yuv420p',
      '-fps_mode:v', 'cfr',
      '-c:a', 'aac',
      '-b:a', '192k',
      '-ar', '48000',
      '-movflags', '+faststart',
      outputName,
    ]);

    checkAbort(signal);
    const data = await ffmpeg.readFile(outputName);
    if (!(data instanceof Uint8Array) || data.byteLength === 0) {
      throw new Error('FFmpeg.wasm гаралтын MP4 хоосон байна.');
    }
    onProgress(82);
    return new Blob([data], { type: 'video/mp4' });
  } catch (error) {
    if (signal?.aborted) {
      throw new DOMException('Processing cancelled.', 'AbortError');
    }
    throw error;
  } finally {
    signal?.removeEventListener('abort', abortHandler);
    if (progressHandler) ffmpeg.off('progress', progressHandler);
    try { await ffmpeg.deleteFile(inputName); } catch (_) {}
    try { await ffmpeg.deleteFile(outputName); } catch (_) {}
  }
}

/**
 * Drop-in processing function for callers using the attached CompressBase JS.
 * Output: MP4, 1080x1920, constant 60 fps, H.264 + AAC, then CompressBase patch.
 *
 * @param {File|Blob} file Input video.
 * @param {(percent:number)=>void} onProgress Progress callback.
 * @param {string} mode Kept for compatibility with the old caller.
 * @param {{postingDevice?:string, signal?:AbortSignal, onStatus?:(s:string)=>void}} options
 * @returns {Promise<{blob:Blob, name:string}>}
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
    throw new Error('ဗီဒီယိုဖိုင်ကို ရွေးပါ။');
  }
  if (file.size < 16) throw new Error('ရွေးထားတဲ့ ဗီဒီယိုဖိုင်က ဗလာဖြစ်နေပါတယ်။');
  if (file.size > 1024 ** 3) {
    throw new Error('Browser မှာလုပ်ဆောင်ရန် 1 GB အောက်ရှိ ဗီဒီယိုကို သုံးပါ။');
  }
  if (!['variant-1', 'variant-2', 'variant-3'].includes(postingDevice)) {
    throw new Error('postingDevice တန်ဖိုး မမှန်ပါ။');
  }
  checkAbort(signal);

  try {
    // Do the 60 fps encode first. Then CompressBase patches that finished MP4,
    // rather than letting its old 30 fps processing path reduce the frame rate.
    const encodedBlob = await encode1080p60(
      file,
      onProgress,
      onStatus,
      signal
    );
    checkAbort(signal);

    onStatus('CompressBase-ийн MP4 patch хийж байна…');
    onProgress(85);
    const { patchVideo } = await getCompressBase();
    if (typeof patchVideo !== 'function') {
      throw new Error('CompressBase-ийн patchVideo module олдсонгүй။');
    }

    const patchInput = new File(
      [encodedBlob],
      'zilem-1080p60.mp4',
      { type: 'video/mp4' }
    );
    const patchedBlob = await patchVideo(patchInput, {
      postingDevice,
      signal,
      onStatus: (message) => onStatus(message),
    });
    if (!(patchedBlob instanceof Blob) || patchedBlob.size === 0) {
      throw new Error('CompressBase хоосон MP4 ဖိုင် ပြန်ပေးခဲ့သည်။');
    }

    onStatus('MP4 metadata ကို ရှင်းလင်းနေသည်…');
    onProgress(94);
    const { blob: outputBlob, removedCount } =
      await removeCompressBaseComment(patchedBlob, signal);
    checkAbort(signal);

    const originalName = (file.name || 'video.mp4').replace(/\.[^/.]+$/, '');
    onProgress(100);
    onStatus(
      removedCount > 0
        ? 'ပြီးပါပြီ။ 1080p60 MP4 ပြုလုပ်ပြီး CompressBase မှတ်ချက်ကို ဖယ်ရှားလိုက်သည်။'
        : 'ပြီးပါပြီ။ 1080p60 MP4 ပြုလုပ်ပြီးဖြစ်သည်။'
    );

    return {
      blob: outputBlob,
      name: `${originalName}-zilem-1080p60.mp4`,
    };
  } catch (error) {
    console.error('Zilem 1080p60 processing error:', error);
    throw error;
  }
}
