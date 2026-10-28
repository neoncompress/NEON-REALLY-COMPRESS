// NEON COMPRESS V3 — LOCAL MP4 CONTAINER PROCESSOR
// No CompressBase API.
// No video/audio re-encoding.
// Preserves original video/audio streams where supported.

import { FFmpeg } from "@ffmpeg/ffmpeg";
import { fetchFile, toBlobURL } from "@ffmpeg/util";

let engine = null;
let enginePromise = null;

async function loadEngine(onStatus) {
  if (engine?.loaded) return engine;
  if (enginePromise) return enginePromise;

  enginePromise = (async () => {
    onStatus("Loading local FFmpeg engine…");

    const ffmpeg = new FFmpeg();

    const base =
      "https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.10/dist/esm";

    let coreURL;
    let wasmURL;

    try {
      coreURL = await toBlobURL(
        `${base}/ffmpeg-core.js`,
        "text/javascript"
      );

      wasmURL = await toBlobURL(
        `${base}/ffmpeg-core.wasm`,
        "application/wasm"
      );

      await ffmpeg.load({ coreURL, wasmURL });

      engine = ffmpeg;
      return ffmpeg;
    } catch (error) {
      ffmpeg.terminate();
      throw error;
    } finally {
      if (coreURL) URL.revokeObjectURL(coreURL);
      if (wasmURL) URL.revokeObjectURL(wasmURL);
    }
  })();

  try {
    return await enginePromise;
  } finally {
    enginePromise = null;
  }
}

export async function removeCompressBaseComment(file, signal) {
  signal?.throwIfAborted();

  // FFmpeg remuxing does not copy the CompressBase comment
  // into the output unless it is explicitly supplied.
  // This helper therefore leaves the input untouched.
  return {
    blob: file,
    removedCount: 0
  };
}

export async function optimizeVideo(
  file,
  onProgress = () => {},
  mode = "max",
  options = {}
) {
  const {
    signal,
    onStatus = () => {}
  } = options ?? {};

  if (
    !file ||
    typeof file.slice !== "function" ||
    typeof file.size !== "number"
  ) {
    throw new Error("Please select a valid video file.");
  }

  if (file.name && !/\.mp4$/i.test(file.name)) {
    throw new Error("Please select an MP4 video.");
  }

  if (file.size < 16) {
    throw new Error("The selected video is too small or empty.");
  }

  signal?.throwIfAborted();

  const ffmpeg = await loadEngine(onStatus);

  signal?.throwIfAborted();

  const inputName = `input-${Date.now()}.mp4`;
  const outputName = `output-${Date.now()}.mp4`;

  const abort = () => {
    // FFmpeg.wasm doesn't provide a per-job abort signal.
    // Terminating it cancels the active engine, so don't
    // terminate a shared engine here.
  };

  signal?.addEventListener("abort", abort, { once: true });

  const progressHandler = ({ progress }) => {
    if (Number.isFinite(progress)) {
      onProgress(
        Math.max(5, Math.min(95, Math.round(progress * 90 + 5)))
      );
    }
  };

  ffmpeg.on("progress", progressHandler);

  try {
    signal?.throwIfAborted();

    onStatus("Reading input video…");
    onProgress(5);

    await ffmpeg.writeFile(inputName, await fetchFile(file));

    signal?.throwIfAborted();

    onStatus("Remuxing MP4 without re-encoding…");

    const code = await ffmpeg.exec([
      "-y",
      "-i", inputName,
      "-map", "0:v:0",
      "-map", "0:a?",
      "-c", "copy",
      "-map_metadata", "-1",
      "-movflags", "+faststart",
      outputName
    ]);

    signal?.throwIfAborted();

    if (code !== 0) {
      throw new Error("FFmpeg could not remux this MP4.");
    }

    const data = await ffmpeg.readFile(outputName);

    if (!(data instanceof Uint8Array) || data.length === 0) {
      throw new Error("The processed video is empty.");
    }

    const blob = new Blob([data], { type: "video/mp4" });

    onProgress(100);
    onStatus("Done. Original video/audio streams were not re-encoded.");

    return {
      blob,
      name: "neoncompress.mp4"
    };
  } finally {
    ffmpeg.off("progress", progressHandler);
    signal?.removeEventListener("abort", abort);

    await ffmpeg.deleteFile(inputName).catch(() => {});
    await ffmpeg.deleteFile(outputName).catch(() => {});
  }
}
