// ZILEM-STYLE TIKTOK QUALITY PROCESSING JS — NO COMPRESSBASE
// This is a new implementation, not Zilem's private source code.
// It re-encodes once to a clean 1080x1920 H.264/AAC MP4 for upload.
// It preserves source frame timestamps/FPS (30 fps stays 30; 60 fps stays 60).
// TikTok can still recompress the upload, so no script can guarantee the final app rendition.
// First use downloads FFmpeg.wasm (~31 MB). Browser processing is slower than native FFmpeg.

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
    throw new DOMException('လုပ်ဆောင်မှုကို ရပ်လိုက်သည်။', 'AbortError');
  }
}

async function getFFmpeg(onStatus = () => {}) {
  if (!ffmpegPromise) {
    ffmpegPromise = (async () => {
      onStatus('FFmpeg ကို ပထမဆုံးအကြိမ် စတင်တင်နေသည် (~31 MB)…');

      const [ffmpegModule, utilModule] = await Promise.all([
        import(/* @vite-ignore */ `${FFMPEG_PACKAGE_BASE}/index.js`),
        import(/* @vite-ignore */ FFMPEG_UTIL_URL),
      ]);
      const { FFmpeg } = ffmpegModule;
      const { toBlobURL } = utilModule;
      if (!FFmpeg || !toBlobURL) {
        throw new Error('FFmpeg.wasm module ကို မတင်နိုင်ပါ။');
      }

      // Avoid the cross-origin Worker error: turn worker.js into a same-origin
      // Blob URL and rewrite its two internal module imports to CDN URLs.
      const workerResponse = await fetch(`${FFMPEG_PACKAGE_BASE}/worker.js`);
      if (!workerResponse.ok) {
        throw new Error(`FFmpeg worker ကို မတင်နိုင်ပါ (${workerResponse.status})။`);
      }
      let workerCode = await workerResponse.text();
      workerCode = workerCode
        .replaceAll('"./const.js"', `"${FFMPEG_PACKAGE_BASE}/const.js"`)
        .replaceAll('"./errors.js"', `"${FFMPEG_PACKAGE_BASE}/errors.js"`);
      if (workerCode.includes('"./const.js"') || workerCode.includes('"./errors.js"')) {
        throw new Error('FFmpeg worker ရဲ့ import လမ်းကြောင်းကို ပြင်မရပါ။');
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
      onStatus('ဗီဒီယိုပြုပြင်ကိရိယာကို စတင်နေသည်…');
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
 * Drop-in Processing JS function.
 * Output: vertical 1080x1920 MP4, H.264 + AAC; source frame timestamps are kept.
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
  // WASM holds decoded frames and file data in browser memory; use short clips.
  if (file.size > 500 * 1024 * 1024) {
    throw new Error('Browser မှာလုပ်ဆောင်ရန် 500 MB အောက်ရှိ ဖိုင်ကို သုံးပါ။');
  }

  const originalName = file.name || 'video.mp4';
  const ext = originalName.match(/\.([^.]+)$/)?.[1]?.toLowerCase() || 'mp4';
  if (!['mp4', 'mov', 'webm', 'm4v'].includes(ext)) {
    throw new Error('MP4, MOV, WEBM သို့မဟုတ် M4V ဗီဒီယိုကို ရွေးပါ။');
  }

  checkAbort(signal);
  let ffmpeg;
  let progressHandler;
  let abortHandler;
  const id = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const inputName = `zilem-input-${id}.${ext}`;
  const outputName = `zilem-output-${id}.mp4`;

  try {
    onProgress(3);
    ffmpeg = await getFFmpeg(onStatus);
    checkAbort(signal);

    onStatus('ဗီဒီယိုကို 1080p အရည်အသွေးမြင့်အဖြစ် encode လုပ်နေသည်…');
    await ffmpeg.writeFile(inputName, new Uint8Array(await file.arrayBuffer()));
    checkAbort(signal);
    onProgress(10);

    progressHandler = ({ progress }) => {
      if (Number.isFinite(progress)) {
        const bounded = Math.max(0, Math.min(1, progress));
        onProgress(Math.round(12 + bounded * 82));
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
      '-vf',
      'scale=1080:1920:force_original_aspect_ratio=decrease:force_divisible_by=2:flags=lanczos,pad=1080:1920:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1',
      '-c:v', 'libx264',
      '-preset', 'ultrafast',
      '-crf', '17',
      '-maxrate', '20M',
      '-bufsize', '40M',
      '-profile:v', 'high',
      '-level:v', '4.2',
      '-pix_fmt', 'yuv420p',
      '-fps_mode:v', 'passthrough',
      '-c:a', 'aac',
      '-b:a', '256k',
      '-ar', '48000',
      '-movflags', '+faststart',
      outputName,
    ], -1, { signal });

    checkAbort(signal);
    if (exitCode !== 0) {
      throw new Error('ဗီဒီယို encode မအောင်မြင်ပါ။ ဖိုင်တိုတစ်ခုနဲ့ ပြန်စမ်းပါ။');
    }

    const outputData = await ffmpeg.readFile(outputName);
    if (!(outputData instanceof Uint8Array) || outputData.byteLength === 0) {
      throw new Error('ထွက်လာတဲ့ MP4 ဖိုင် ဗလာဖြစ်နေပါတယ်။');
    }

    const baseName = originalName.replace(/\.[^.]+$/, '');
    onProgress(100);
    onStatus('ပြီးပါပြီ။ 1080p MP4 ပြုလုပ်ပြီး မူရင်း FPS ကို ထိန်းထားပါသည်။');
    return {
      blob: new Blob([outputData], { type: 'video/mp4' }),
      name: `${baseName}-tiktok-1080p-sourcefps.mp4`,
    };
  } catch (error) {
    if (signal?.aborted) {
      throw new DOMException('လုပ်ဆောင်မှုကို ရပ်လိုက်သည်။', 'AbortError');
    }
    console.error('TikTok quality processing error:', error);
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
