// Processing arguments and FFmpeg version copied from the user's working Replit App.tsx.
// MAX QUALITY only: stream copy, no re-encoding, no resolution/FPS changes.
import { FFmpeg } from '@ffmpeg/ffmpeg';
import { toBlobURL } from '@ffmpeg/util';

let ffmpegRef = null;

export async function optimizeVideo(file, onProgress = () => {}) {
  if (!/\.mp4$/i.test(file.name)) throw new Error('MAX QUALITY currently supports MP4 input only.');
  const originalName = file.name.replace(/\.[^/.]+$/, '');
  const outputName = `${originalName}-neon-max-quality.mp4`;
  const inputName = `input-${Date.now()}.${file.name.split('.').pop() || 'mp4'}`;
  const outputNameInFs = `neon-${Date.now()}.mp4`;
  const ffmpeg = ffmpegRef ?? new FFmpeg();
  ffmpegRef = ffmpeg;
  const onFFmpegProgress = ({ progress }) => {
    if (Number.isFinite(progress)) onProgress(Math.max(4, Math.min(96, Math.round(progress * 92))));
  };
  try {
    onProgress(2);
    if (!ffmpeg.loaded) {
      const baseUrl = 'https://unpkg.com/@ffmpeg/core@0.12.10/dist/esm';
      await ffmpeg.load({
        coreURL: await toBlobURL(`${baseUrl}/ffmpeg-core.js`, 'text/javascript'),
        wasmURL: await toBlobURL(`${baseUrl}/ffmpeg-core.wasm`, 'application/wasm'),
      });
    }
    ffmpeg.on('progress', onFFmpegProgress);
    const fileData = new Uint8Array(
      await file.arrayBuffer().catch(() => { throw new Error('FILE_READ_FAILED: Browser cannot read selected video'); })
    );
    await ffmpeg.writeFile(inputName, fileData);
    // Exact MAX QUALITY command from Replit working backup:
    const args = [
      '-i', inputName,
      '-map', '0:v:0',
      '-map', '0:a?',
      '-c', 'copy',
      '-movflags', '+faststart',
      '-y', outputNameInFs,
    ];
    const exitCode = await ffmpeg.exec(args);
    if (exitCode !== 0) throw new Error(`FFmpeg exited with code ${exitCode}.`);
    const outputData = await ffmpeg.readFile(outputNameInFs);
    if (!(outputData instanceof Uint8Array)) throw new Error('Unexpected binary output.');
    const outputBytes = new Uint8Array(outputData);
    const outputBlob = new Blob([outputBytes], { type: 'video/mp4' });
    if (outputBlob.size === 0) throw new Error('FFmpeg produced an empty MP4.');
    onProgress(100);
    return { blob: outputBlob, name: outputName };
  } finally {
    ffmpeg.off('progress', onFFmpegProgress);
    try { await ffmpeg.deleteFile(inputName); } catch { /* ignore */ }
    try { await ffmpeg.deleteFile(outputNameInFs); } catch { /* ignore */ }
  }
}
