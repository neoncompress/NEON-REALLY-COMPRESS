// Processing.js
// NEON COMPRESS V3 — FAST QUALITY + FPS PROCESSOR
//
// Full browser-side MP4 timing-metadata experiment. This version does not use
// the CompressBase API and does not re-encode video or audio. It reads the
// source frame timing from the MP4 stts table, then patches only the movie-level
// mvhd time scale and duration. The video-track mdhd/stts entries are preserved
// so local MP4 readers continue to identify the source track as 60/120fps.
//
// IMPORTANT: This metadata experiment has NOT been verified to make TikTok
// preserve 60fps. TikTok can transcode uploads on its servers. Keep the source.
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

function throwIfAborted(signal) {
  if (!signal?.aborted) return;
  const error = signal.reason instanceof Error
    ? signal.reason
    : new Error('Processing was cancelled.');
  if (!error.name || error.name === 'Error') {
    error.name = 'AbortError';
  }
  throw error;
}

function atomType(bytes, offset) {
  return String.fromCharCode(
    bytes[offset + 4],
    bytes[offset + 5],
    bytes[offset + 6],
    bytes[offset + 7]
  );
}

/** Parse sibling MP4 boxes from an already-loaded region. */
function parseBoxes(bytes, start, end) {
  const boxes = [];
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = start;

  while (offset + 8 <= end) {
    let size = view.getUint32(offset, false);
    const type = atomType(bytes, offset);
    let headerSize = 8;

    if (size === 1) {
      if (offset + 16 > end) {
        throw new Error('The MP4 contains an incomplete extended box header.');
      }
      const largeSize = view.getBigUint64(offset + 8, false);
      if (largeSize > BigInt(Number.MAX_SAFE_INTEGER)) {
        throw new Error('The MP4 box is too large for safe metadata editing.');
      }
      size = Number(largeSize);
      headerSize = 16;
    } else if (size === 0) {
      size = end - offset;
    }

    // UUID boxes carry a 16-byte user-type field after the standard header.
    if (type === 'uuid') {
      headerSize += 16;
    }

    if (size < headerSize || offset + size > end) {
      throw new Error('The MP4 atom structure is invalid; no output was written.');
    }

    const box = {
      type,
      start: offset,
      size,
      headerSize,
      end: offset + size,
      children: []
    };

    if (MP4_CONTAINER_TYPES.has(type)) {
      box.children = parseBoxes(bytes, offset + headerSize, offset + size);
    }

    boxes.push(box);
    offset += size;
  }

  if (offset < end && end - offset >= 8) {
    throw new Error('Could not safely parse the complete MP4 box tree.');
  }

  return boxes;
}

function getChild(box, type) {
  return box.children.find((candidate) => candidate.type === type) ?? null;
}

/** Get the MP4 FullBox version and movie/media timing-field offsets. */
function getTimingFields(bytes, box) {
  const fullBoxOffset = box.start + box.headerSize;
  if (fullBoxOffset + 4 > box.end) {
    throw new Error(`The ${box.type} box is incomplete.`);
  }

  const version = bytes[fullBoxOffset];
  if (version !== 0 && version !== 1) {
    throw new Error(`The ${box.type} box has an unsupported version.`);
  }

  // FullBox flags (4 bytes), creation time, modification time.
  const timeScaleOffset = fullBoxOffset + 4 + (version === 1 ? 16 : 8);
  const durationOffset = timeScaleOffset + 4;
  const durationBytes = version === 1 ? 8 : 4;

  if (durationOffset + durationBytes > box.end) {
    throw new Error(`The ${box.type} timing fields are incomplete.`);
  }

  return { timeScaleOffset, durationOffset, durationBytes };
}

function readTimeScale(bytes, box) {
  const { timeScaleOffset } = getTimingFields(bytes, box);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return view.getUint32(timeScaleOffset, false);
}

/**
 * Determine whether a track is video and measure its average FPS from stts.
 * The video track's timing metadata is inspected but never modified.
 */
function readVideoTrackInfo(bytes, trackBox) {
  const mediaBox = getChild(trackBox, 'mdia');
  if (!mediaBox) return null;

  const handlerBox = getChild(mediaBox, 'hdlr');
  const mediaHeaderBox = getChild(mediaBox, 'mdhd');
  const mediaInfoBox = getChild(mediaBox, 'minf');
  const sampleTableBox = mediaInfoBox && getChild(mediaInfoBox, 'stbl');
  const timeToSampleBox = sampleTableBox && getChild(sampleTableBox, 'stts');

  if (!handlerBox || !mediaHeaderBox || !timeToSampleBox) {
    return null;
  }

  // hdlr FullBox: version/flags (4), pre_defined (4), handler_type (4).
  const handlerOffset = handlerBox.start + handlerBox.headerSize + 8;
  if (handlerOffset + 4 > handlerBox.end) {
    return null;
  }

  const handlerType = String.fromCharCode(
    bytes[handlerOffset],
    bytes[handlerOffset + 1],
    bytes[handlerOffset + 2],
    bytes[handlerOffset + 3]
  );
  if (handlerType !== 'vide') {
    return null;
  }

  const timeScale = readTimeScale(bytes, mediaHeaderBox);
  if (timeScale === 0) {
    throw new Error('The video track has a zero time scale.');
  }

  const sttsOffset = timeToSampleBox.start + timeToSampleBox.headerSize;
  if (sttsOffset + 8 > timeToSampleBox.end) {
    throw new Error('The video sample timing table is invalid.');
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const entryCount = view.getUint32(sttsOffset + 4, false);
  if (
    entryCount === 0 ||
    sttsOffset + 8 + entryCount * 8 > timeToSampleBox.end
  ) {
    throw new Error('The video track has no valid frame-timing entries.');
  }

  let totalSamples = 0;
  let totalTicks = 0;
  let firstSampleDelta = null;
  let constantFrameInterval = true;
  let entryOffset = sttsOffset + 8;

  for (let index = 0; index < entryCount; index += 1) {
    const sampleCount = view.getUint32(entryOffset, false);
    const sampleDelta = view.getUint32(entryOffset + 4, false);

    if (sampleCount === 0 || sampleDelta === 0) {
      throw new Error('The video track contains an invalid frame-timing entry.');
    }

    totalSamples += sampleCount;
    totalTicks += sampleCount * sampleDelta;

    if (firstSampleDelta === null) {
      firstSampleDelta = sampleDelta;
    } else if (sampleDelta !== firstSampleDelta) {
      constantFrameInterval = false;
    }

    entryOffset += 8;
  }

  return {
    fps: totalSamples * timeScale / totalTicks,
    constantFrameInterval
  };
}

/** Change only mvhd time scale and duration; the ratio stays the same. */
function patchMovieHeader(bytes, movieHeaderBox, divider) {
  const {
    timeScaleOffset,
    durationOffset,
    durationBytes
  } = getTimingFields(bytes, movieHeaderBox);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const oldTimeScale = view.getUint32(timeScaleOffset, false);

  if (oldTimeScale < divider) {
    throw new Error('The movie time scale is too small for this patch.');
  }

  const newTimeScale = Math.max(1, Math.floor(oldTimeScale / divider));
  view.setUint32(timeScaleOffset, newTimeScale, false);

  if (durationBytes === 8) {
    const oldDuration = view.getBigUint64(durationOffset, false);
    view.setBigUint64(durationOffset, oldDuration / BigInt(divider), false);
  } else {
    const oldDuration = view.getUint32(durationOffset, false);
    view.setUint32(durationOffset, Math.floor(oldDuration / divider), false);
  }
}

/** Find the moov atom without reading the full video payload into memory. */
async function findMovieBox(file, signal) {
  let offset = 0;

  while (offset + 8 <= file.size) {
    throwIfAborted(signal);

    const headerBytes = new Uint8Array(
      await file.slice(offset, Math.min(offset + 16, file.size)).arrayBuffer()
    );
    if (headerBytes.length < 8) {
      break;
    }

    const view = new DataView(
      headerBytes.buffer,
      headerBytes.byteOffset,
      headerBytes.byteLength
    );
    let boxSize = view.getUint32(0, false);
    const type = atomType(headerBytes, 0);
    let headerSize = 8;

    if (boxSize === 1) {
      if (headerBytes.length < 16) {
        throw new Error('The MP4 has an incomplete extended top-level header.');
      }
      const largeSize = view.getBigUint64(8, false);
      if (largeSize > BigInt(Number.MAX_SAFE_INTEGER)) {
        throw new Error('The MP4 box is too large for safe processing.');
      }
      boxSize = Number(largeSize);
      headerSize = 16;
    } else if (boxSize === 0) {
      boxSize = file.size - offset;
    }

    if (type === 'uuid') {
      headerSize += 16;
    }

    if (boxSize < headerSize || offset + boxSize > file.size) {
      throw new Error('The top-level MP4 atom structure is invalid.');
    }

    if (type === 'moov') {
      return { start: offset, size: boxSize };
    }

    offset += boxSize;
  }

  throw new Error('Could not find the MP4 moov metadata box.');
}

/**
 * Apply the experimental movie-header metadata patch.
 *
 * @param {File|Blob} file MP4 source video.
 * @param {(percent:number)=>void} onProgress Progress callback.
 * @param {string} mode Kept for compatibility with the existing UI; unused.
 * @param {{signal?:AbortSignal,onStatus?:(message:string)=>void}} options
 * @returns {Promise<{blob:Blob,name:string,sourceFps:number}>}
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

  if (!file || typeof file.slice !== 'function' || typeof file.size !== 'number') {
    throw new Error('Please select a valid video file.');
  }
  if (file.name && !/\.mp4$/i.test(file.name)) {
    throw new Error('Please select an MP4 video.');
  }
  if (file.size < 16) {
    throw new Error('The selected video file is empty or too small.');
  }

  throwIfAborted(signal);
  onProgress(5);
  onStatus('Reading MP4 timing metadata…');

  const movieInfo = await findMovieBox(file, signal);
  if (movieInfo.size > 256 * 1024 * 1024) {
    throw new Error('The MP4 metadata box is unexpectedly large.');
  }

  const movieBytes = new Uint8Array(
    await file.slice(movieInfo.start, movieInfo.start + movieInfo.size).arrayBuffer()
  );
  throwIfAborted(signal);

  const topLevelBoxes = parseBoxes(movieBytes, 0, movieBytes.length);
  const movieBox = topLevelBoxes.find((box) => box.type === 'moov');
  if (!movieBox) {
    throw new Error('Could not parse the MP4 moov box.');
  }

  const movieHeaderBox = getChild(movieBox, 'mvhd');
  const tracks = movieBox.children.filter((box) => box.type === 'trak');
  const videoTracks = tracks
    .map((track) => readVideoTrackInfo(movieBytes, track))
    .filter(Boolean);

  if (!movieHeaderBox || videoTracks.length !== 1) {
    throw new Error('This patch expects one supported MP4 video track.');
  }

  const videoTrack = videoTracks[0];
  const roundedFps = Math.round(videoTrack.fps);
  if (
    !videoTrack.constantFrameInterval ||
    ![60, 120].includes(roundedFps) ||
    Math.abs(videoTrack.fps - roundedFps) > 0.25
  ) {
    throw new Error(
      `Only constant 60fps or 120fps video is supported; detected about ${videoTrack.fps.toFixed(3)}fps.`
    );
  }

  const divider = roundedFps === 60 ? 2 : 4;
  onProgress(35);
  onStatus(`Applying experimental movie-header metadata patch for ${roundedFps}fps…`);
  throwIfAborted(signal);

  // Do not patch video mdhd/stts: changing those fields made 60fps report as
  // 30fps locally. The movie-level header is adjusted while the video stream's
  // actual timing and all audio/video payload bytes remain untouched.
  patchMovieHeader(movieBytes, movieHeaderBox, divider);

  throwIfAborted(signal);
  const patchedMovie = new Blob([movieBytes], { type: 'video/mp4' });
  const outputBlob = new Blob([
    file.slice(0, movieInfo.start),
    patchedMovie,
    file.slice(movieInfo.start + movieInfo.size)
  ], { type: 'video/mp4' });

  onProgress(100);
  onStatus(
    `Done. Movie-level metadata patched; the video track remains ${roundedFps}fps locally.`
  );

  return {
    blob: outputBlob,
    name: 'neoncompress.mp4',
    sourceFps: roundedFps
  };
}
