// NEON COMPRESS V3 — FAST QUALITY + FPS PROCESSOR
// Fast path: do not re-encode the video. The original picture, audio and FPS
// remain unchanged; CompressBase patches MP4 metadata/container locally.
// After patching, remove only the exact "Patched by Compressbase" comment
// from the MP4 moov metadata. No video/audio samples are re-encoded.

let compressBaseModulePromise = null;

async function getCompressBase() {
  if (!compressBaseModulePromise) {
    // @vite-ignore keeps this official browser module external to the app bundle.
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
 * Remove the exact CompressBase comment from the MP4 moov atom.
 * This only edits the metadata bytes; video/audio data and timestamps stay intact.
 *
 * @param {Blob} file Patched MP4.
 * @param {AbortSignal} [signal] Optional cancellation signal.
 * @returns {Promise<{blob: Blob, removedCount: number}>}
 */
export async function removeCompressBaseComment(file, signal) {
  const marker = new TextEncoder().encode('Patched by Compressbase');
  const chunkSize = 1024 * 1024;
  let offset = 0;
  let moovStart = -1;
  let moovEnd = -1;
  let moovHeaderSize = 8;

  // Read only MP4 atom headers until the metadata (moov) atom is found.
  while (offset + 8 <= file.size) {
    signal?.throwIfAborted();
    const headerBytes = new Uint8Array(await file.slice(offset, offset + 16).arrayBuffer());
    if (headerBytes.length < 8) break;

    const view = new DataView(headerBytes.buffer, headerBytes.byteOffset, headerBytes.byteLength);
    let atomSize = view.getUint32(0);
    const atomType = String.fromCharCode(
      headerBytes[4], headerBytes[5], headerBytes[6], headerBytes[7]
    );
    let headerSize = 8;

    if (atomSize === 1) {
      if (headerBytes.length < 16) {
        throw new Error('The MP4 has an incomplete extended atom header.');
      }
      const extendedSize = view.getBigUint64(8);
      if (extendedSize > BigInt(Number.MAX_SAFE_INTEGER)) {
        throw new Error('The MP4 atom is too large for safe metadata editing.');
      }
      atomSize = Number(extendedSize);
      headerSize = 16;
    } else if (atomSize === 0) {
      atomSize = file.size - offset;
    }

    if (atomSize < headerSize || offset + atomSize > file.size) {
      throw new Error('The MP4 atom structure is invalid; metadata was not changed.');
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
    throw new Error('Could not find the MP4 metadata atom (moov).');
  }

  // Search only inside moov, never in the compressed video/audio payload.
  const searchStart = moovStart + moovHeaderSize;
  const foundOffsets = [];
  let scanStart = searchStart;

  while (scanStart < moovEnd) {
    signal?.throwIfAborted();
    const ownedEnd = Math.min(scanStart + chunkSize, moovEnd);
    const readEnd = Math.min(ownedEnd + marker.length - 1, moovEnd);
    const bytes = new Uint8Array(await file.slice(scanStart, readEnd).arrayBuffer());

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

  // Replace the text with zero bytes of the same length, keeping every MP4
  // atom size and every video/audio sample exactly where it was.
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

/**
 * Apply the CompressBase Quality + FPS patch without the slow FFmpeg re-encode.
 * Keeps the source video/audio streams intact; this is a fast container patch,
 * not image sharpening or TikTok compression removal.
 *
 * @param {File|Blob} file MP4 selected directly from an <input type="file">.
 * @param {(percent: number) => void} onProgress Optional UI progress callback.
 * @param {string} mode Retained for compatibility with existing callers.
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
  if (file.name && !/\.mp4$/i.test(file.name)) {
    throw new Error('Please select an MP4 video.');
  }
  if (file.size < 16) {
    throw new Error('The selected video file is too small or empty.');
  }
  if (file.size > 8 * 1024 ** 3) {
    throw new Error('CompressBase supports MP4 files up to 8 GiB.');
  }
  if (!['variant-1', 'variant-2', 'variant-3'].includes(postingDevice)) {
    throw new Error('Choose variant-1, variant-2, or variant-3.');
  }

  signal?.throwIfAborted();
  onProgress(5);
  onStatus('Preparing the MP4 for Quality + FPS…');

  try {
    const { patchVideo } = await getCompressBase();
    signal?.throwIfAborted();

    const patchedBlob = await patchVideo(file, {
      postingDevice,
      signal,
      onStatus: (message) => {
        onStatus(message);
        onProgress(70);
      },
    });

    if (!(patchedBlob instanceof Blob) || patchedBlob.size === 0) {
      throw new Error('CompressBase returned an empty MP4.');
    }

    onStatus('Removing the CompressBase comment from MP4 metadata…');
    onProgress(85);
    const { blob: outputBlob, removedCount } = await removeCompressBaseComment(
      patchedBlob,
      signal
    );
    signal?.throwIfAborted();

    const sourceName = file.name || 'video.mp4';
    const originalName = sourceName.replace(/\.mp4$/i, '');
    const suffix = mode === 'tiktok' ? '-neon-tiktok-quality-fps' : '-neon-quality-fps';

    onProgress(100);
    onStatus(
      removedCount > 0
        ? 'Done. CompressBase comment removed; video and FPS were not re-encoded.'
        : 'Done. No CompressBase comment was found; video and FPS were not re-encoded.'
    );
    return {
      blob: outputBlob,
      name: `${originalName}${suffix}.mp4`,
    };
  } catch (error) {
    console.error('NEON COMPRESS processing error:', error);
    throw error;
  }
}
