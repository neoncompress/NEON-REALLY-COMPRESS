// Processing.js 1080p 30fps
// NEON COMPRESS V3 — Experimental MP4 Timing Header Patch
//
// - No FFmpeg or video/audio re-encoding.
// - No external CompressBase imports or API calls.
// - Preserves the original compressed media payload.
// - Supports constant-frame-interval 60fps or 120fps MP4 video.
// - Patches the movie-level mvhd timing fields only.
// - Does not modify video mdhd/stts or audio timing metadata.
// - This experimental patch does NOT convert the actual video FPS.
// - TikTok may still transcode the uploaded video.
//
// Output filename: neoncompress.mp4

const MP4_CONTAINER_TYPES = new Set([
  'moov',
  'trak',
  'mdia',
  'minf',
  'stbl',
  'edts',
  'dinf',
  'mvex',
  'moof',
  'traf',
  'mfra'
]);

function abortIfNeeded(signal) {
  if (!signal?.aborted) return;

  const error =
    signal.reason instanceof Error
      ? signal.reason
      : new Error('Processing was cancelled.');

  if (!error.name || error.name === 'Error') {
    error.name = 'AbortError';
  }

  throw error;
}

function boxType(bytes, offset) {
  if (offset < 0 || offset + 8 > bytes.length) {
    throw new Error('Invalid MP4 box header.');
  }

  return String.fromCharCode(
    bytes[offset + 4],
    bytes[offset + 5],
    bytes[offset + 6],
    bytes[offset + 7]
  );
}

function parseBoxes(bytes, start, end) {
  const boxes = [];

  let pos = start;

  const view = new DataView(
    bytes.buffer,
    bytes.byteOffset,
    bytes.byteLength
  );

  while (pos + 8 <= end) {
    let size = view.getUint32(pos, false);

    const type = boxType(bytes, pos);

    let headerSize = 8;

    if (size === 1) {
      if (pos + 16 > end) {
        throw new Error(
          'Incomplete extended MP4 box header.'
        );
      }

      const largeSize = view.getBigUint64(
        pos + 8,
        false
      );

      if (largeSize > BigInt(Number.MAX_SAFE_INTEGER)) {
        throw new Error(
          'MP4 box is too large for safe processing.'
        );
      }

      size = Number(largeSize);
      headerSize = 16;
    } else if (size === 0) {
      size = end - pos;
    }

    if (type === 'uuid') {
      headerSize += 16;
    }

    if (
      size < headerSize ||
      pos + size > end
    ) {
      throw new Error(
        'Invalid MP4 box structure. No output was produced.'
      );
    }

    const box = {
      type,
      start: pos,
      size,
      headerSize,
      end: pos + size,
      children: []
    };

    if (MP4_CONTAINER_TYPES.has(type)) {
      box.children = parseBoxes(
        bytes,
        pos + headerSize,
        pos + size
      );
    }

    boxes.push(box);

    pos += size;
  }

  if (pos !== end && end - pos >= 8) {
    throw new Error(
      'Could not safely parse the complete MP4 box structure.'
    );
  }

  return boxes;
}

function child(box, type) {
  return (
    box.children.find(
      (item) => item.type === type
    ) ?? null
  );
}

function descendants(box, type, out = []) {
  for (const item of box.children) {
    if (item.type === type) {
      out.push(item);
    }

    if (item.children.length) {
      descendants(item, type, out);
    }
  }

  return out;
}

function readFullBoxVersion(bytes, box) {
  const offset = box.start + box.headerSize;

  if (offset + 4 > box.end) {
    throw new Error(
      `Invalid ${box.type} box.`
    );
  }

  const version = bytes[offset];

  if (version !== 0 && version !== 1) {
    throw new Error(
      `Unsupported ${box.type} version ${version}.`
    );
  }

  return {
    offset,
    version
  };
}

function timingFieldOffsets(bytes, box) {
  const {
    offset,
    version
  } = readFullBoxVersion(bytes, box);

  // FullBox header + creation_time + modification_time.
  const timeScaleOffset =
    offset + 4 + (version === 1 ? 16 : 8);

  const durationOffset =
    timeScaleOffset + 4;

  const durationBytes =
    version === 1 ? 8 : 4;

  if (
    durationOffset + durationBytes >
    box.end
  ) {
    throw new Error(
      `Invalid timing fields in ${box.type}.`
    );
  }

  return {
    timeScaleOffset,
    durationOffset,
    durationBytes
  };
}

function readTimeScale(bytes, box) {
  const {
    timeScaleOffset
  } = timingFieldOffsets(bytes, box);

  return new DataView(
    bytes.buffer,
    bytes.byteOffset,
    bytes.byteLength
  ).getUint32(timeScaleOffset, false);
}

function readVideoTrackInfo(bytes, trak) {
  const mdia = child(trak, 'mdia');

  if (!mdia) {
    return null;
  }

  const hdlr = child(mdia, 'hdlr');
  const mdhd = child(mdia, 'mdhd');
  const minf = child(mdia, 'minf');
  const stbl = minf && child(minf, 'stbl');
  const stts = stbl && child(stbl, 'stts');

  if (!hdlr || !mdhd || !stts) {
    return null;
  }

  const hdlrOffset =
    hdlr.start + hdlr.headerSize;

  // FullBox version/flags (4 bytes), pre_defined (4),
  // then handler_type (4 bytes).
  if (hdlrOffset + 12 > hdlr.end) {
    return null;
  }

  const handler = String.fromCharCode(
    bytes[hdlrOffset + 8],
    bytes[hdlrOffset + 9],
    bytes[hdlrOffset + 10],
    bytes[hdlrOffset + 11]
  );

  if (handler !== 'vide') {
    return null;
  }

  const timescale = readTimeScale(
    bytes,
    mdhd
  );

  if (timescale === 0) {
    throw new Error(
      'Video track has a zero time scale.'
    );
  }

  const sttsOffset =
    stts.start + stts.headerSize;

  if (sttsOffset + 8 > stts.end) {
    throw new Error(
      'Invalid video stts box.'
    );
  }

  const view = new DataView(
    bytes.buffer,
    bytes.byteOffset,
    bytes.byteLength
  );

  const entryCount = view.getUint32(
    sttsOffset + 4,
    false
  );

  if (
    entryCount === 0 ||
    sttsOffset + 8 + entryCount * 8 >
      stts.end
  ) {
    throw new Error(
      'Video track has no valid frame timing table.'
    );
  }

  let totalSamples = 0;
  let totalTicks = 0;
  let firstDelta = null;
  let constantDelta = true;

  let cursor = sttsOffset + 8;

  for (
    let i = 0;
    i < entryCount;
    i += 1
  ) {
    const count = view.getUint32(
      cursor,
      false
    );

    const delta = view.getUint32(
      cursor + 4,
      false
    );

    if (count === 0 || delta === 0) {
      throw new Error(
        'Invalid video frame timing entry.'
      );
    }

    totalSamples += count;
    totalTicks += count * delta;

    if (firstDelta === null) {
      firstDelta = delta;
    } else if (delta !== firstDelta) {
      constantDelta = false;
    }

    cursor += 8;
  }

  if (
    totalSamples === 0 ||
    totalTicks === 0
  ) {
    throw new Error(
      'Could not calculate the source video frame rate.'
    );
  }

  return {
    mdhd,
    fps: totalSamples * timescale / totalTicks,
    constantDelta
  };
}

function divideTimingFields(bytes, box, divider) {
  const {
    timeScaleOffset,
    durationOffset,
    durationBytes
  } = timingFieldOffsets(bytes, box);

  const view = new DataView(
    bytes.buffer,
    bytes.byteOffset,
    bytes.byteLength
  );

  const oldTimescale = view.getUint32(
    timeScaleOffset,
    false
  );

  if (
    oldTimescale < divider ||
    oldTimescale % divider !== 0
  ) {
    throw new Error(
      `Cannot safely divide ${box.type} time scale by ${divider}.`
    );
  }

  const newTimescale =
    oldTimescale / divider;

  if (newTimescale < 1) {
    throw new Error(
      `Invalid resulting ${box.type} time scale.`
    );
  }

  view.setUint32(
    timeScaleOffset,
    newTimescale,
    false
  );

  if (durationBytes === 8) {
    const oldDuration =
      view.getBigUint64(
        durationOffset,
        false
      );

    view.setBigUint64(
      durationOffset,
      oldDuration / BigInt(divider),
      false
    );
  } else {
    const oldDuration =
      view.getUint32(
        durationOffset,
        false
      );

    view.setUint32(
      durationOffset,
      Math.floor(oldDuration / divider),
      false
    );
  }
}

async function findMoov(file, signal) {
  let offset = 0;

  while (offset + 8 <= file.size) {
    abortIfNeeded(signal);

    const head = new Uint8Array(
      await file
        .slice(
          offset,
          Math.min(offset + 16, file.size)
        )
        .arrayBuffer()
    );

    if (head.length < 8) {
      break;
    }

    const view = new DataView(
      head.buffer,
      head.byteOffset,
      head.byteLength
    );

    let size = view.getUint32(
      0,
      false
    );

    const type = boxType(head, 0);

    let headerSize = 8;

    if (size === 1) {
      if (head.length < 16) {
        throw new Error(
          'Incomplete extended top-level MP4 box header.'
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
          'MP4 box is too large.'
        );
      }

      size = Number(largeSize);
      headerSize = 16;
    } else if (size === 0) {
      size = file.size - offset;
    }

    if (type === 'uuid') {
      headerSize += 16;
    }

    if (
      size < headerSize ||
      offset + size > file.size
    ) {
      throw new Error(
        'Invalid top-level MP4 box structure.'
      );
    }

    if (type === 'moov') {
      return {
        start: offset,
        size,
        headerSize
      };
    }

    offset += size;
  }

  throw new Error(
    'Could not find the MP4 moov metadata box.'
  );
}

/**
 * Patch MP4 movie timing metadata without re-encoding.
 *
 * @param {File|Blob} file
 * @param {(percent: number) => void} onProgress
 * @param {string} mode Kept for UI compatibility.
 * @param {{signal?: AbortSignal, onStatus?: (message: string) => void}} options
 * @returns {Promise<{blob: Blob, name: string, sourceFps: number}>}
 */
export async function optimizeVideo(
  file,
  onProgress = () => {},
  mode = 'max',
  options = {}
) {
  void mode;

  const {
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
      'The selected video file is empty or too small.'
    );
  }

  abortIfNeeded(signal);

  onProgress(5);

  onStatus(
    'Reading MP4 timing metadata…'
  );

  const moovInfo = await findMoov(
    file,
    signal
  );

  if (
    moovInfo.size >
    256 * 1024 * 1024
  ) {
    throw new Error(
      'The MP4 moov metadata box is unexpectedly large.'
    );
  }

  const moovBytes = new Uint8Array(
    await file
      .slice(
        moovInfo.start,
        moovInfo.start + moovInfo.size
      )
      .arrayBuffer()
  );

  abortIfNeeded(signal);

  const top = parseBoxes(
    moovBytes,
    0,
    moovBytes.length
  );

  const moov = top.find(
    (box) => box.type === 'moov'
  );

  if (!moov) {
    throw new Error(
      'Could not parse the MP4 moov box.'
    );
  }

  const mvhd = child(
    moov,
    'mvhd'
  );

  const tracks = moov.children.filter(
    (box) => box.type === 'trak'
  );

  const videoTracks = tracks
    .map((trak) =>
      readVideoTrackInfo(
        moovBytes,
        trak
      )
    )
    .filter(Boolean);

  if (
    !mvhd ||
    videoTracks.length === 0
  ) {
    throw new Error(
      'Could not find a supported MP4 movie/video track.'
    );
  }

  if (videoTracks.length !== 1) {
    throw new Error(
      'This patch supports MP4 files with exactly one video track.'
    );
  }

  const videoTrack = videoTracks[0];

  const roundedFps = Math.round(
    videoTrack.fps
  );

  const fpsTolerance = 0.5;

  // Require constant frame timing and a source FPS
  // sufficiently close to either 60 or 120.
  if (
    !videoTrack.constantDelta ||
    ![60, 120].includes(roundedFps) ||
    Math.abs(
      videoTrack.fps - roundedFps
    ) > fpsTolerance
  ) {
    throw new Error(
      `Unsupported video timing: ${videoTrack.fps.toFixed(3)}fps; constant=${videoTrack.constantDelta}. This experimental patch supports constant 60fps or 120fps MP4 video only.`
    );
  }

  const divider =
    roundedFps === 60 ? 2 : 4;

  onProgress(35);

  onStatus(
    `Patching ${roundedFps}fps MP4 movie timing metadata without re-encoding…`
  );

  abortIfNeeded(signal);

  // Experimental movie-header patch only.
  // Video mdhd/stts and audio timing remain unchanged.
  divideTimingFields(
    moovBytes,
    mvhd,
    divider
  );

  abortIfNeeded(signal);

  const patchedMoov = new Blob(
    [moovBytes],
    {
      type: 'video/mp4'
    }
  );

  const outputBlob = new Blob(
    [
      file.slice(
        0,
        moovInfo.start
      ),

      patchedMoov,

      file.slice(
        moovInfo.start + moovInfo.size
      )
    ],
    {
      type: 'video/mp4'
    }
  );

  onProgress(100);

  onStatus(
    `Done. Movie timing metadata patched for source ${roundedFps}fps. Video and audio were not re-encoded.`
  );

  return {
    blob: outputBlob,
    name: 'neoncompress.mp4',
    sourceFps: roundedFps
  };
}
