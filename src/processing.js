// ZILEM / NEON COMPRESS — FAST PROCESSING JS
// Paste this whole module into the Processing JS field.
// Fast path: no FFmpeg.wasm, no resizing, no FPS conversion, no video re-encode.
// Applies only CompressBase's container patch to the original MP4, then removes
// the exact CompressBase marker from the MP4 moov metadata if present.
// Source resolution and REAL source FPS stay as they are; TikTok can still re-encode.

let compressBaseModulePromise = null;

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

function checkAbort(signal) {
  if (signal?.aborted) {
    throw new DOMException('Processing cancelled.', 'AbortError');
  }
}

/** Remove only the exact CompressBase comment from the MP4 moov atom. */
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
        throw new Error('MP4 metadata header မပြည့်စုံပါ။');
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
      throw new Error('MP4 atom бүтэц буруу тул metadata-г өөрчилсөнгүй။');
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

/** Drop-in Processing JS function. Preserves source resolution/FPS; runs fast. */
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
  if (file.size < 16) {
    throw new Error('ရွေးထားတဲ့ ဗီဒီယိုဖိုင်က ဗလာဖြစ်နေပါတယ်။');
  }
  if (file.size > 8 * 1024 ** 3) {
    throw new Error('CompressBase က 8 GB အထိ MP4 ဖိုင်ကိုသာ လက်ခံသည်။');
  }
  if (file.name && !/\.mp4$/i.test(file.name)) {
    throw new Error('မြန်ဆန်တဲ့ mode အတွက် MP4 ဖိုင်ကို ရွေးပါ။');
  }
  if (!['variant-1', 'variant-2', 'variant-3'].includes(postingDevice)) {
    throw new Error('postingDevice တန်ဖိုး မမှန်ပါ။');
  }

  checkAbort(signal);
  onProgress(5);

  try {
    onStatus('မူရင်းဗီဒီယိုကို မပြန် encode ဘဲ patch လုပ်နေသည်…');
    const { patchVideo } = await getCompressBase();
    if (typeof patchVideo !== 'function') {
      throw new Error('CompressBase patchVideo module ကို မရရှိနိုင်ပါ။');
    }

    // Pass the original MP4 directly. This intentionally skips the slow
    // FFmpeg.wasm upscale/FPS-conversion pipeline.
    const patchedBlob = await patchVideo(file, {
      postingDevice,
      signal,
      onStatus: (message) => onStatus(message),
    });
    if (!(patchedBlob instanceof Blob) || patchedBlob.size === 0) {
      throw new Error('CompressBase က ဗလာ MP4 ဖိုင်ကို ပြန်ပေးခဲ့သည်။');
    }

    checkAbort(signal);
    onProgress(85);
    onStatus('MP4 metadata ကို ရှင်းလင်းနေသည်…');
    const { blob: outputBlob, removedCount } =
      await removeCompressBaseComment(patchedBlob, signal);

    checkAbort(signal);
    onProgress(100);
    onStatus(
      removedCount > 0
        ? 'ပြီးပါပြီ။ မူရင်း resolution/FPS ကို ထိန်းထားပြီး metadata မှတ်ချက်ကို ဖယ်ရှားလိုက်သည်။'
        : 'ပြီးပါပြီ။ မူရင်း resolution/FPS ကို ထိန်းထားသည်။'
    );

    const sourceName = file.name || 'video.mp4';
    const baseName = sourceName.replace(/\.mp4$/i, '');
    const suffix = mode === 'tiktok' ? '-fast-tiktok' : '-fast';
    return {
      blob: outputBlob,
      name: `${baseName}${suffix}.mp4`,
    };
  } catch (error) {
    console.error('Fast processing error:', error);
    throw error;
  }
}
