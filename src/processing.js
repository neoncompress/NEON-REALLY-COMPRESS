// NEON COMPRESS V3 — FAST QUALITY + FPS PROCESSOR
// Fast path: do not re-encode the video.
// Original picture, audio and FPS remain unchanged.
// CompressBase patches MP4 metadata/container locally.
// Removes only the exact "Patched by Compressbase" comment
// from MP4 moov metadata if present.
//
// Output filename: neoncompress.mp4

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

/**
 * Remove the exact CompressBase comment from the MP4 moov atom.
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

  // Find the MP4 moov atom.
  while (offset + 8 <= file.size) {
    signal?.throwIfAborted();

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
      headerBytes[4],
      headerBytes[5],
      headerBytes[6],
      headerBytes[7]
    );

    let headerSize = 8;

    if (atomSize === 1) {
      if (headerBytes.length < 16) {
        throw new Error(
          'The MP4 has an incomplete extended atom header.'
        );
      }

      const extendedSize = view.getBigUint64(8);

      if (extendedSize > BigInt(Number.MAX_SAFE_INTEGER)) {
        throw new Error(
          'The MP4 atom is too large for safe metadata editing.'
        );
      }

     
