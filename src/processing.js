// ZILEM-STYLE PROCESSING JS — NO COMPRESSBASE
// Implements the public Zilem Method description: remux compatible MP4/MOV
// video/audio streams into MP4 with stream copy. No pixels or audio samples are
// re-encoded, and no resolution/FPS filter is applied. This is an implementation
// of that publicly described approach, not Zilem's private source code.
//
// First use downloads FFmpeg.wasm (~31 MB). Processing should be much faster
// than 1080p60 re-encoding, but remuxing does not turn a 30 fps source into 60 fps.

let ffmpegPromise = null;
let classWorkerURL = null;

const FFMPEG_PACKAGE_BASE =
  'https://cdn.jsdelivr.net/npm/@ffmpeg/ffmpeg@0.12.15/dist/esm';
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
      onStatus('FFmpeg processor-ийг эхлүүлж байна… (анх удаа ~31 MB татна)');

      const [ffmpegModule, utilModule] = await Promise.all([
        import(/* @vite-ignore */ `${FFMPEG_PACKAGE_BASE}/index.js`),
        import(/* @vite-ignore */ FFMPEG_UTIL_URL),
      ]);
      const { FFmpeg } = ffmpegModule;
      const { toBlobURL } = utilModule;
      if (!FFmpeg || !toBlobURL) {
        throw new Error('FFmpeg.wasm module ачаалж чадсангүй.');
      }

      // Load FFmpeg's worker as a Blob URL. This avoids the cross-origin
      // Worker error when the app is hosted on a different domain than jsDelivr.
      const workerResponse = await fetch(`${FFMPEG_PACKAGE_BASE}/worker.js`);
      if (!workerResponse.ok) {
        throw new Error(`FFmpeg worker татаж чадсангүй (${workerResponse.status}).`);
      }
      let workerCode = await workerResponse.text();
      workerCode = workerCode
        .replaceAll('"./const.js"', `"${FFMPEG_PACKAGE_BASE}/const.js"`)
        .replaceAll('"./errors.js"', `"${FFMPEG_PACKAGE_BASE}/errors.js"`);
      if (workerCode.includes('"./const.js"') || workerCode.includes('"./errors.js"')) {
        throw new Error('FFmpeg worker-ийн import зам буруу байна.');
      }

      classWorkerURL = URL.createObjectURL(
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

      const ffmpeg = new FFmpeg();
      onStatus('FFmpeg ကို browser дотор ачаалж байна…');
      await ffmpeg.load({ classWorkerURL, coreURL, wasmURL });
      return ffmpeg;
    })().catch((error) => {
      if (classWorkerURL) {
        URL.revokeObjectURL(classWorkerURL);
        classWorkerURL = null;
      }
      ffmpegPromise = null;
      throw error;
    });
  }
  return ffmpegPromise;
}

/**
 * Processing-JS compatible entry point.
 * @param {File|Blob} file MP4 or MOV source. H.264/HEVC are supported by design.
 * @param {(percent:number)=>void} onProgress Existing UI progress callback.
 * @param {string} mode Kept for compatibility with existing Processing JS callers.
 * @param {{postingDevice?:string, signal?:AbortSignal, onStatus?:(s:string)=>void}} options
 * @returns {Promise<{blob:Blob, name:string}>}
 */
export async function optimizeVideo(
  file,
  onProgress = () => {},
  mode = 'max',
  options = {}
) {
  const { signal, onStatus = () => {} } = options ?? {};

  if (!file || typeof file.slice !== 'function' || typeof file.size !== 'number') {
    throw new Error('ဗီဒီယိုဖိုင်ကို ရွေးပါ။');
  }
  if (file.size < 16) {
    throw new Error('ရွေးထားတဲ့ ဗီဒီယိုဖိုင်က ဗလာဖြစ်နေပါတယ်။');
  }
  // FFmpeg.wasm keeps working data in browser memory; large files may exhaust
  // phone memory, so use a conservative client-side size cap.
  if (file.size > 700 * 1024 * 1024) {
    throw new Error('Browser မှာလုပ်ဆောင်ရန် 700 MB အောက်ရှိ ဗီဒီယိုဖိုင်ကို သုံးပါ။');
  }
  const fileName = file.name || 'video.mp4';
  const extension = fileName.match(/\.([^.]+)$/)?.[1]?.toLowerCase();
  if (!['mp4', 'mov'].includes(extension)) {
    throw new Error('MP4 သို့မဟုတ် MOV ဗီဒီယိုဖိုင်ကို ရွေးပါ။');
  }

  checkAbort(signal);
  let ffmpeg;
  let progressHandler;
  let abortHandler;
  const id = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const inputName = `zilem-input-${id}.${extension}`;
  const outputName = `zilem-output-${id}.mp4`;

  try {
    onProgress(5);
    ffmpeg = await getFFmpeg(onStatus);
    checkAbort(signal);

    onStatus('Видео stream-ийг дахин encode хийхгүйгээр MP4 болгон remux хийж байна…');
    const inputData = new Uint8Array(await file.arrayBuffer());
    checkAbort(signal);
    await ffmpeg.writeFile(inputName, inputData);

    progressHandler = ({ progress }) => {
      // FFmpeg.wasm progress is approximate for remux jobs.
      if (Number.isFinite(progress)) {
        const bounded = Math.max(0, Math.min(1, progress));
        onProgress(Math.round(10 + bounded * 80));
      }
    };
    ffmpeg.on('progress', progressHandler);

    abortHandler = () => {
      try {
        ffmpeg.terminate();
      } finally {
        if (classWorkerURL) {
          URL.revokeObjectURL(classWorkerURL);
          classWorkerURL = null;
        }
        ffmpegPromise = null;
      }
    };
    signal?.addEventListener('abort', abortHandler, { once: true });

    const exitCode = await ffmpeg.exec([
      '-i', inputName,
      '-map', '0:v:0',
      '-map', '0:a?',
      '-map_metadata', '0',
      '-map_chapters', '0',
      '-c', 'copy',
      '-fps_mode:v:0', 'passthrough',
      '-movflags', '+faststart',
      outputName,
    ], -1, { signal });

    checkAbort(signal);
    if (exitCode !== 0) {
      throw new Error('MP4 remux မအောင်မြင်ပါ။ ဗီဒီယို codec ကိုစစ်ပါ။ H.264/HEVC MP4/MOV ကို စမ်းသုံးပါ။');
    }

    const outputData = await ffmpeg.readFile(outputName);
    if (!(outputData instanceof Uint8Array) || outputData.byteLength === 0) {
      throw new Error('ထွက်လာတဲ့ MP4 ဖိုင် ဗလာဖြစ်နေပါတယ်။');
    }

    const blob = new Blob([outputData], { type: 'video/mp4' });
    const baseName = fileName.replace(/\.(mp4|mov)$/i, '');
    onProgress(100);
    onStatus('ပြီးပါပြီ။ မူရင်းဗီဒီယို၏ FPS ကို မပြောင်းဘဲ ထိန်းထားပါသည်။');

    return {
      blob,
      name: `${baseName}-zilem-remux.mp4`,
    };
  } catch (error) {
    if (signal?.aborted) {
      throw new DOMException('Processing cancelled.', 'AbortError');
    }
    console.error('Zilem-style remux error:', error);
    throw error;
  } finally {
    signal?.removeEventListener('abort', abortHandler);
    if (ffmpeg && progressHandler) ffmpeg.off('progress', progressHandler);
    if (ffmpeg) {
      try { await ffmpeg.deleteFile(inputName); } catch (_) {}
      try { await ffmpeg.deleteFile(outputName); } catch (_) {}
    }
  }
}
