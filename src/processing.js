// NEON COMPRESS V3
// STANDALONE MP4 METADATA PROCESSOR
//
// CompressBase: NOT USED
// External processing API: NOT USED
// Video re-encoding: NOT USED
//
// Timing patch:
//   60 FPS mode  -> divide mvhd/mdhd timescale and duration by 2
//   120 FPS mode -> divide mvhd/mdhd timescale and duration by 4
//
// IMPORTANT:
// This changes MP4 timing metadata only.
// It does not convert the actual video to 60/120 FPS.
// Keep the original video as a backup.
//
// Output filename: neoncompress.mp4

const MAX_VIDEO_SIZE = 8 * 1024 ** 3;

const CONTAINER_TYPES = new Set([
  'moov',
  'trak',
  'mdia',
  'edts',
  'dinf',
  'mvex',
  'moof',
  'traf',
  'mfra'
]);

// --------------------------------------------------
// ABORT CHECK
// --------------------------------------------------

function checkAbort(signal) {
  if (signal?.aborted) {
    throw new DOMException(
      'Video processing was cancelled.',
      'AbortError'
    );
  }
}

// --------------------------------------------------
// READ MP4 BOX HEADER
// --------------------------------------------------

async function readBox(
  file,
  position,
  parentEnd,
  signal
) {
  checkAbort(signal);

  if (position + 8 > parentEnd) {
    return null;
  }

  const bytes = new Uint8Array(
    await file.slice(
      position,
      Math.min(position + 16, parentEnd)
    ).arrayBuffer()
  );

  if (bytes.length < 8) {
    return null;
  }

  const view = new DataView(
    bytes.buffer,
    bytes.byteOffset,
    bytes.byteLength
  );

  let size = view.getUint32(0, false);

  const type = String.fromCharCode(
    bytes[4],
    bytes[5],
    bytes[6],
    bytes[7]
  );

  let headerSize = 8;

  if (size === 1) {
    if (bytes.length < 16) {
      throw new Error(
        'Invalid MP4: incomplete extended box header.'
      );
    }

    const largeSize = view.getBigUint64(
      8,
      false
    );

    if (
      largeSize >
      BigInt(Number.MAX_SAFE_INTEGER)
    ) {
      throw new Error(
        'MP4 box is too large to process safely.'
      );
    }

    size = Number(largeSize);
    headerSize = 16;

  } else if (size === 0) {
    size = parentEnd - position;
  }

  if (
    size < headerSize ||
    position + size > parentEnd
  ) {
    throw new Error(
      `Invalid MP4 box structure: ${type}`
    );
  }

  return {
    type,
    position,
    size,
    headerSize,
    end: position + size
  };
}

// --------------------------------------------------
// CREATE BINARY REPLACEMENTS
// --------------------------------------------------

function uint32Bytes(value) {
  const bytes = new Uint8Array(4);

  new DataView(
    bytes.buffer
  ).setUint32(
    0,
    value,
    false
  );

  return bytes;
}

function uint64Bytes(value) {
  const bytes = new Uint8Array(8);

  new DataView(
    bytes.buffer
  ).setBigUint64(
    0,
    value,
    false
  );

  return bytes;
}

// --------------------------------------------------
// PATCH mvhd / mdhd
// --------------------------------------------------

async function patchTimingHeader(
  file,
  box,
  divider,
  signal
) {
  checkAbort(signal);

  const fullBoxPosition =
    box.position + box.headerSize;

  const readLength = Math.min(
    32,
    box.end - fullBoxPosition
  );

  if (readLength < 4) {
    return [];
  }

  const bytes = new Uint8Array(
    await file.slice(
      fullBoxPosition,
      fullBoxPosition + readLength
    ).arrayBuffer()
  );

  const view = new DataView(
    bytes.buffer,
    bytes.byteOffset,
    bytes.byteLength
  );

  const version = bytes[0];

  if (version !== 0 && version !== 1) {
    return [];
  }

  const wide = version === 1;

  // FullBox version + flags = 4 bytes.
  // Version 0 timestamps are 32-bit.
  // Version 1 timestamps are 64-bit.
  const timestampBytes = wide ? 16 : 8;

  const timescaleOffset =
    4 + timestampBytes;

  const durationOffset =
    timescaleOffset + 4;

  const durationBytes = wide ? 8 : 4;

  if (
    durationOffset + durationBytes >
    bytes.length
  ) {
    return [];
  }

  const timescalePosition =
    fullBoxPosition + timescaleOffset;

  const durationPosition =
    fullBoxPosition + durationOffset;

  const oldTimescale = view.getUint32(
    timescaleOffset,
    false
  );

  const oldDuration = wide
    ? view.getBigUint64(
        durationOffset,
        false
      )
    : view.getUint32(
        durationOffset,
        false
      );

  const newTimescale = Math.max(
    1,
    Math.floor(oldTimescale / divider)
  );

  const newDuration = wide
    ? oldDuration / BigInt(divider)
    : Math.floor(oldDuration / divider);

  return [
    {
      position: timescalePosition,
      bytes: uint32Bytes(newTimescale)
    },
    {
      position: durationPosition,
      bytes: wide
        ? uint64Bytes(newDuration)
        : uint32Bytes(newDuration)
    }
  ];
}

// --------------------------------------------------
// WALK MP4 BOX TREE
// --------------------------------------------------

async function walkBoxes(
  file,
  start,
  end,
  divider,
  signal,
  replacements,
  patchedCounts,
  state
) {
  let position = start;

  while (position + 8 <= end) {
    checkAbort(signal);

    const box = await readBox(
      file,
      position,
      end,
      signal
    );

    if (!box) {
      break;
    }

    state.boxesVisited += 1;

    if (state.boxesVisited > 100000) {
      throw new Error(
        'MP4 contains too many boxes to process safely.'
      );
    }

    if (
      box.type === 'mvhd' ||
      box.type === 'mdhd'
    ) {
      const changes = await patchTimingHeader(
        file,
        box,
        divider,
        signal
      );

      if (changes.length > 0) {
        replacements.push(...changes);
        patchedCounts[box.type] += 1;
      }
    }

    if (CONTAINER_TYPES.has(box.type)) {
      await walkBoxes(
        file,
        box.position + box.headerSize,
        box.end,
        divider,
        signal,
        replacements,
        patchedCounts,
        state
      );
    }

    position = box.end;
  }
}

// --------------------------------------------------
// PUBLIC: PATCH MP4 TIMING METADATA
//
// fps = 60  -> divider 2
// fps = 120 -> divider 4
// --------------------------------------------------

export async function patchMp4Timing(
  file,
  fps = 60,
  signal
) {
  if (fps !== 60 && fps !== 120) {
    throw new Error(
      'FPS mode must be 60 or 120.'
    );
  }

  if (
    !file ||
    typeof file.slice !== 'function' ||
    typeof file.size !== 'number'
  ) {
    throw new Error(
      'Please select a valid video file.'
    );
  }

  if (file.size < 16) {
    throw new Error(
      'The selected file is empty or too small.'
    );
  }

  if (file.size > MAX_VIDEO_SIZE) {
    throw new Error(
      'The selected video exceeds the 8 GiB limit.'
    );
  }

  checkAbort(signal);

  const divider = fps === 60 ? 2 : 4;

  const replacements = [];

  const patchedCounts = {
    mvhd: 0,
    mdhd: 0
  };

  const state = {
    boxesVisited: 0
  };

  await walkBoxes(
    file,
    0,
    file.size,
    divider,
    signal,
    replacements,
    patchedCounts,
    state
  );

  checkAbort(signal);

  if (
    patchedCounts.mvhd +
    patchedCounts.mdhd === 0
  ) {
    throw new Error(
      'No supported mvhd/mdhd timing headers were found.'
    );
  }

  // Sort replacements by their original byte offsets.
  replacements.sort(
    (a, b) => a.position - b.position
  );

  // Assemble a new Blob without overwriting the input.
  const parts = [];

  let copyFrom = 0;

  for (const item of replacements) {
    checkAbort(signal);

    if (item.position < copyFrom) {
      throw new Error(
        'Overlapping MP4 metadata fields were detected.'
      );
    }

    if (item.position > copyFrom) {
      parts.push(
        file.slice(
          copyFrom,
          item.position
        )
      );
    }

    parts.push(item.bytes);

    copyFrom =
      item.position + item.bytes.length;
  }

  if (copyFrom < file.size) {
    parts.push(
      file.slice(copyFrom)
    );
  }

  const blob = new Blob(parts, {
    type: 'video/mp4'
  });

  return {
    blob,
    fps,
    divider,
    patched: {
      mvhd: patchedCounts.mvhd,
      mdhd: patchedCounts.mdhd
    }
  };
}

// --------------------------------------------------
// MAIN PROCESSING FUNCTION
// Compatible with optimizeVideo(file, onProgress, mode, options)
// --------------------------------------------------

export async function optimizeVideo(
  file,
  onProgress = () => {},
  mode = 'max',
  options = {}
) {
  const {
    signal,
    onStatus = () => {},
    timingPatchFps = 60
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
      'The selected video is too small or empty.'
    );
  }

  if (file.size > MAX_VIDEO_SIZE) {
    throw new Error(
      'The selected video exceeds the 8 GiB limit.'
    );
  }

  if (
    timingPatchFps !== 60 &&
    timingPatchFps !== 120
  ) {
    throw new Error(
      'timingPatchFps must be 60 or 120.'
    );
  }

  checkAbort(signal);

  try {
    onProgress(5);

    onStatus(
      'NEON COMPRESS: Reading MP4 metadata…'
    );

    onProgress(15);

    const result = await patchMp4Timing(
      file,
      timingPatchFps,
      signal
    );

    checkAbort(signal);

    onProgress(100);

    onStatus(
      `Finished. Updated ${result.patched.mvhd} mvhd and ${result.patched.mdhd} mdhd timing header(s).`
    );

    return {
      blob: result.blob,
      name: 'neoncompress.mp4'
    };

  } catch (error) {
    console.error(
      'NEON COMPRESS processing error:',
      error
    );

    throw error;
  }
}

// --------------------------------------------------
// DOWNLOAD HELPER
// Optional: call this if your existing UI needs it.
// --------------------------------------------------

export function downloadProcessedVideo(
  blob,
  filename = 'neoncompress.mp4'
) {
  if (!(blob instanceof Blob)) {
    throw new Error(
      'A valid processed video Blob is required.'
    );
  }

  const url = URL.createObjectURL(blob);

  const link = document.createElement('a');

  link.href = url;
  link.download = filename;
  link.style.display = 'none';

  document.body.appendChild(link);
  link.click();
  link.remove();

  // Delay revocation to allow the browser to start the download.
  setTimeout(() => {
    URL.revokeObjectURL(url);
  }, 30000);
}
