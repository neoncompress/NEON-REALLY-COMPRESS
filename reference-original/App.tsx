import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type DragEvent,
  type ReactNode,
} from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ErrorBoundary } from "@/components/error-boundary";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import NotFound from "@/pages/not-found";
import {
  Check,
  Download,
  FileVideo,
  LockKeyhole,
  RefreshCcw,
  Share2,
  TriangleAlert,
  Upload,
  X,
  Zap,
} from "lucide-react";
import { FFmpeg } from "@ffmpeg/ffmpeg";
import { toBlobURL } from "@ffmpeg/util";
import { Route, Switch, useLocation, Router as WouterRouter } from "wouter";

const queryClient = new QueryClient();

function Home() {
  type Quality = "max-quality" | "file-size";
  type FlowState = "empty" | "selected" | "compressing" | "complete";
  type FpsOption = "source" | "60" | "120"; // 🌟 FPS အမျိုးအစားသစ်များ သတ်မှတ်ခြင်း

  const [flowState, setFlowState] = useState<FlowState>("empty");
  const [quality, setQuality] = useState<Quality>("max-quality");
  const [targetFps, setTargetFps] = useState<FpsOption>("source"); // 🌟 FPS State
  const [file, setFile] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState("");
  const [compressedUrl, setCompressedUrl] = useState("");
  const [compressedBlob, setCompressedBlob] = useState<Blob | null>(null);
  const [compressedFileName, setCompressedFileName] = useState("");
  const [saveMessage, setSaveMessage] = useState("");
  const [sourceResolution, setSourceResolution] = useState("—");
  const [sourceFps, setSourceFps] = useState("Source");
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState("");
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [isDragging, setIsDragging] = useState(false);
  const ffmpegRef = useRef<FFmpeg | null>(null);

  const qualityData = {
    "max-quality": {
      label: "MAX QUALITY + FPS",
      detail: "Keep original video and audio quality",
      ratio: 1.00,
      bitrate: "Original video/audio · stream copy",
    },
    "file-size": {
      label: "OPTIMIZE FILE SIZE",
      detail: "Smaller upload, good quality",
      ratio: 0.72,
      bitrate: "8 Mbps",
    },
  } as const;

  const compressedBytes = useMemo(
    () =>
      file
        ? Math.max(1024, Math.round(file.size * qualityData[quality].ratio))
        : 0,
    [file, quality],
  );

  useEffect(() => {
    return () => {
      if (previewUrl) {
        URL.revokeObjectURL(previewUrl);
      }
      if (compressedUrl) {
        URL.revokeObjectURL(compressedUrl);
      }
    };
  }, []);

  const formatBytes = (bytes: number) => {
    if (!bytes) return "—";
    const units = ["B", "KB", "MB", "GB"];
    const unitIndex = Math.min(
      Math.floor(Math.log(bytes) / Math.log(1024)),
      units.length - 1,
    );
    const value = bytes / 1024 ** unitIndex;
    return `${value >= 100 || unitIndex === 0 ? Math.round(value) : value.toFixed(1)} ${units[unitIndex]}`;
  };

  const isSupportedVideo = (candidate: File) => {
    const supportedTypes = [
      "video/mp4",
      "video/webm",
      "video/quicktime",
      "video/x-m4v",
      "video/mpeg",
    ];
    return (
      supportedTypes.includes(candidate.type) ||
      /\.(mp4|webm|mov|m4v|mpeg|mpg)$/i.test(candidate.name)
    );
  };

  const selectFile = (candidate?: File) => {
    if (!candidate) return;
    if (!isSupportedVideo(candidate)) {
      setError(
        "That file type is not supported. Choose an MP4, MOV, WEBM, or MPEG video.",
      );
      setFlowState("empty");
      return;
    }
    if (candidate.size === 0) {
      setError(
        "This video is empty or unreadable. Try choosing it again from your phone.",
      );
      setFlowState("empty");
      return;
    }
    setError("");
    setSaveMessage("");
    setProgress(0);
    setFlowState("selected");
    setFile(candidate);
    setCompressedBlob(null);
    setCompressedFileName("");
    setSourceResolution("—");
    setSourceFps("Source");
    setCompressedUrl("");
    setPreviewUrl((current) => {
      if (current) URL.revokeObjectURL(current);
      return URL.createObjectURL(candidate);
    });
  };

  const onFileChange = (event: ChangeEvent<HTMLInputElement>) => {
    selectFile(event.target.files?.[0]);
    event.target.value = "";
  };

  const onDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setIsDragging(false);
    selectFile(event.dataTransfer.files?.[0]);
  };


  const startCompression = async () => {
    if (!file || flowState === "compressing") return;

    const maxQuality = quality === "max-quality";

    if (maxQuality && !/\.mp4$/i.test(file.name)) {
      setError(
        "MAX QUALITY currently supports MP4 input only. Please choose an MP4 video."
      );
      return;
    }

    if (maxQuality && targetFps !== "source") {
      setError(
        "MAX QUALITY preserves original FPS. Please select Original FPS."
      );
      return;
    }

    const originalName = file.name.replace(/\.[^/.]+$/, "");

    const fpsSuffix =
      maxQuality || targetFps === "source"
        ? ""
        : `-${targetFps}fps`;

    const outputName =
      `${originalName}-neon-${quality}${fpsSuffix}.mp4`;

    setError("");
    setSaveMessage("");
    setFlowState("compressing");
    setProgress(2);

    const inputName =
      `input-${Date.now()}.${file.name.split(".").pop() || "mp4"}`;

    const outputNameInFs = `neon-${Date.now()}.mp4`;

    const ffmpeg = ffmpegRef.current ?? new FFmpeg();
    ffmpegRef.current = ffmpeg;

    const onProgress = ({
      progress,
    }: {
      progress: number;
    }) => {
      if (Number.isFinite(progress)) {
        setProgress(
          Math.max(4, Math.min(96, Math.round(progress * 92)))
        );
      }
    };

    try {
      if (!ffmpeg.loaded) {
        const baseUrl =
          "https://unpkg.com/@ffmpeg/core@0.12.10/dist/esm";

        await ffmpeg.load({
          coreURL: await toBlobURL(
            `${baseUrl}/ffmpeg-core.js`,
            "text/javascript"
          ),
          wasmURL: await toBlobURL(
            `${baseUrl}/ffmpeg-core.wasm`,
            "application/wasm"
          ),
        });
      }

      ffmpeg.on("progress", onProgress);

      const fileData = new Uint8Array(
        await file.arrayBuffer().catch(() => { throw new Error("FILE_READ_FAILED: Browser cannot read selected video"); })
      );

      await ffmpeg.writeFile(inputName, fileData);

      let args: string[];

      if (maxQuality) {
        // Preserve encoded video and audio streams.
        // No video/audio re-encoding.
        args = [
          "-i", inputName,
          "-map", "0:v:0",
          "-map", "0:a?",
          "-c", "copy",
          "-movflags", "+faststart",
          "-y", outputNameInFs,
        ];
      } else {
        // Smaller file mode uses re-encoding.
        args = [
          "-i", inputName,
          "-map", "0:v:0",
          "-map", "0:a?",
          "-c:v", "libx264",
          "-preset", "ultrafast",
          "-crf", "23",
          "-pix_fmt", "yuv420p",
          ...(
            targetFps === "source"
              ? ["-fps_mode", "passthrough"]
              : ["-r", targetFps]
          ),
          "-movflags", "+faststart",
          "-c:a", "aac",
          "-b:a", "128k",
          "-y", outputNameInFs,
        ];
      }

      const exitCode = await ffmpeg.exec(args);

      if (exitCode !== 0) {
        throw new Error(
          `FFmpeg exited with code ${exitCode}.`
        );
      }

      const outputData = await ffmpeg.readFile(
        outputNameInFs
      );

      if (!(outputData instanceof Uint8Array)) {
        throw new Error("Unexpected binary output.");
      }

      const outputBytes = new Uint8Array(outputData);

      const outputBlob = new Blob(
        [outputBytes],
        { type: "video/mp4" }
      );

      if (outputBlob.size === 0) {
        throw new Error("FFmpeg produced an empty MP4.");
      }

      setCompressedBlob(outputBlob);
      setCompressedFileName(outputName);

      setCompressedUrl((current) => {
        if (current) URL.revokeObjectURL(current);
        return URL.createObjectURL(outputBlob);
      });

      setProgress(100);
      setFlowState("complete");

    } catch (compressionError) {
      setFlowState("selected");
      setProgress(0);

      setError(
        compressionError instanceof Error
          ? `Video optimization failed: ${compressionError.message}`
          : "Video optimization failed. Try a shorter MP4 video."
      );

    } finally {
      ffmpeg.off("progress", onProgress);

      try {
        await ffmpeg.deleteFile(inputName);
      } catch {
        // Ignore cleanup errors.
      }

      try {
        await ffmpeg.deleteFile(outputNameInFs);
      } catch {
        // Ignore cleanup errors.
      }
    }
  };

  const downloadCompressed = () => {
    if (!compressedBlob || !compressedFileName) return;
    const downloadUrl = URL.createObjectURL(compressedBlob);
    const link = document.createElement("a");
    link.href = downloadUrl;
    link.download = compressedFileName;
    link.type = "video/mp4";
    link.rel = "noopener";
    document.body.appendChild(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(downloadUrl), 60_000);
  };

  const saveVideo = async () => {
    if (!compressedBlob || !compressedFileName) return;
    const videoFile = new File([compressedBlob], compressedFileName, {
      type: "video/mp4",
    });
    const shareData = {
      files: [videoFile],
      title: "NEON COMPRESS",
      text: "Save your compressed video",
    };
    const canShareFiles =
      typeof navigator !== "undefined" &&
      typeof navigator.share === "function" &&
      typeof navigator.canShare === "function" &&
      navigator.canShare(shareData);

    if (canShareFiles) {
      try {
        await navigator.share(shareData);
        setSaveMessage(
          "Choose Google Photos or Gallery in the share sheet to save it there.",
        );
      } catch (shareError) {
        if (
          shareError instanceof DOMException &&
          shareError.name === "AbortError"
        )
          return;
        setSaveMessage(
          "The share sheet was unavailable. Download the MP4, then open it from Files > Downloads.",
        );
      }
      return;
    }

    downloadCompressed();
    setSaveMessage(
      "Saved to Files > Downloads. Open the MP4 there, then choose Share to Google Photos or Move to DCIM/Camera.",
    );
  };

  const clearFile = () => {
    setFile(null);
    setError("");
    setProgress(0);
    setCompressedBlob(null);
    setCompressedFileName("");
    setSaveMessage("");
    setFlowState("empty");
    setPreviewUrl((current) => {
      if (current) URL.revokeObjectURL(current);
      return "";
    });
    setCompressedUrl((current) => {
      if (current) URL.revokeObjectURL(current);
      return "";
    });
  };

  const statusLabel =
    flowState === "compressing"
      ? progress < 35
        ? "Reading video"
        : progress < 75
          ? "Optimizing frames"
          : "Packing share-ready file"
      : "Ready to optimize";

  return (
    <main className="neon-app">
      <div className="app-shell">
        <header className="topbar">
          <div className="brand-lockup" aria-label="NEON COMPRESS home">
            <span className="brand-mark" aria-hidden="true">
              <Zap size={16} strokeWidth={2.5} />
            </span>
            <span>NEON COMPRESS</span>
          </div>
          <div className="privacy-chip" data-testid="status-private">
            <span className="privacy-dot" aria-hidden="true" />
            <LockKeyhole size={12} aria-hidden="true" />
            <span>Runs on your device</span>
          </div>
        </header>

        <section className="hero" aria-labelledby="page-title">
          <div className="eyebrow">
            <span className="eyebrow-line" /> pocket utility / 01
          </div>
          <h1 id="page-title">
            Make it <em>share-ready.</em>
          </h1>
          <p className="hero-copy">
            Prepare your video for TikTok with stable playback, sharp detail,
            and upload-ready MP4 settings.
          </p>
        </section>

        <section className="workspace" aria-label="Video compression workspace">
          <div className="panel upload-panel">
            <div className="panel-kicker">
              <span>01 / add video</span>
              <strong>local only</strong>
            </div>
            <div
              className={`drop-zone ${previewUrl ? "has-video" : ""} ${isDragging ? "is-dragging" : ""}`}
              onDragOver={(event) => {
                event.preventDefault();
                setIsDragging(true);
              }}
              onDragLeave={() => setIsDragging(false)}
              onDrop={onDrop}
              data-testid="drop-zone-video"
            >
              {previewUrl && file ? (
                <>
                  <video
                    className="video-preview"
                    src={previewUrl}
                    controls
                    playsInline
                    preload="metadata"
                    onLoadedMetadata={(event) => {
                      const video = event.currentTarget;
                      if (video.videoWidth && video.videoHeight) {
                        setSourceResolution(
                          `${video.videoWidth} × ${video.videoHeight}`,
                        );
                      }
                      const videoWithCapture = video as HTMLVideoElement & {
                        captureStream?: () => MediaStream;
                      };
                      const captureStream = videoWithCapture.captureStream?.();
                      const frameRate = captureStream
                        ?.getVideoTracks()[0]
                        ?.getSettings().frameRate;
                      if (frameRate)
                        setSourceFps(String(Math.round(frameRate * 100) / 100));
                      captureStream
                        ?.getTracks()
                        .forEach((track) => track.stop());
                    }}
                    data-testid="video-preview"
                  >
                    Your browser cannot preview this video.
                  </video>
                  <div className="video-overlay">
                    <span className="file-name" title={file.name}>
                      {file.name}
                    </span>
                    <span className="file-meta">{formatBytes(file.size)}</span>
                  </div>
                </>
              ) : (
                <div className="drop-empty">
                  <div className="upload-orb" aria-hidden="true">
                    <FileVideo size={28} strokeWidth={1.5} />
                  </div>
                  <h2>Drop your video here</h2>
                  <p>
                    MP4, MOV, WEBM or MPEG. Up to your phone's full camera roll.
                  </p>
                  <button
                    className="button-lime"
                    onClick={() => fileInputRef.current?.click()}
                    type="button"
                    data-testid="button-upload-video"
                  >
                    <Upload size={16} aria-hidden="true" />
                    Choose video
                  </button>
                  <input
                    ref={fileInputRef}
                    className="sr-only-input"
                    type="file"
                    accept="video/mp4,video/webm,video/quicktime,video/x-m4v,video/mpeg"
                    onChange={onFileChange}
                    aria-label="Choose a video to compress"
                    data-testid="input-video-file"
                  />
                </div>
              )}
            </div>
            {previewUrl && file && (
              <div className="flex items-center justify-between gap-3 pt-3">
                <span className="font-mono-ui text-[9px] uppercase tracking-[0.08em] text-[#68736a]">
                  Tap preview to inspect
                </span>
                <button
                  className="button-ghost"
                  onClick={() => fileInputRef.current?.click()}
                  type="button"
                  data-testid="button-replace-video"
                >
                  <RefreshCcw size={13} aria-hidden="true" />
                  Replace
                </button>
                <input
                  ref={fileInputRef}
                  className="sr-only-input"
                  type="file"
                  accept="video/mp4,video/webm,video/quicktime,video/x-m4v,video/mpeg"
                  onChange={onFileChange}
                  aria-label="Replace selected video"
                  data-testid="input-replace-video"
                />
              </div>
            )}
          </div>

          <div className="panel settings-panel">
            <div className="panel-kicker">
              <span>02 / tune output</span>
              <span className="font-mono-ui text-[10px] text-[#657065]">
                H.264 / MP4 · yuv420p
              </span>
            </div>
            <h2 className="settings-title">Optimize for TikTok</h2>
            <p className="settings-subtitle">
              Choose maximum upload quality or a smaller file. MAX QUALITY + FPS
              never targets a smaller output.
            </p>
            <fieldset
              className="border-0 p-0 m-0"
              disabled={flowState === "compressing"}
            >
              <legend className="quality-label">Quality preset</legend>
              <div className="quality-grid">
                {(Object.keys(qualityData) as Quality[]).map((option) => (
                  <label
                    className="quality-option"
                    key={option}
                    data-testid={`label-quality-${option}`}
                  >
                    <input
                      type="radio"
                      name="quality"
                      value={option}
                      checked={quality === option}
                      onChange={() => setQuality(option)}
                      data-testid={`input-quality-${option}`}
                    />
                    <span className="quality-card">
                      <span className="quality-name">
                        {qualityData[option].label}
                      </span>
                      <span className="quality-detail">
                        {qualityData[option].detail}
                      </span>
                    </span>
                  </label>
                ))}
              </div>
            </fieldset>

            {/* 🌟 Frame Rate (FPS) Selector UI ခုတ်ထည့်ထားသည့်နေရာ */}
            <fieldset
              className="border-0 p-0 m-0 mt-4"
              disabled={flowState === "compressing"}
            >
              <legend className="quality-label">Target Frame Rate (FPS)</legend>
              <div className="grid grid-cols-3 gap-2 mt-1">
                {(
                  [
                    { id: "source", label: "Original FPS" },
                    { id: "60", label: "60 FPS" },
                    { id: "120", label: "120 FPS" },
                  ] as const
                ).map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => setTargetFps(item.id)}
                    className={`px-3 py-2 text-xs font-mono-ui rounded border transition-colors ${
                      targetFps === item.id
                        ? "bg-[#caff3d] text-black border-[#caff3d] font-bold"
                        : "bg-black/20 text-[#a0aab0] border-[#303833] hover:border-[#4d5750]"
                    }`}
                  >
                    {item.label}
                  </button>
                ))}
              </div>
            </fieldset>

            <div
              className="technical-readout mt-4"
              aria-label="Video optimization details"
            >
              <div className="technical-group">
                <span className="technical-heading">Original</span>
                <div className="technical-row">
                  <span>Resolution</span>
                  <strong>{sourceResolution}</strong>
                </div>
                <div className="technical-row">
                  <span>FPS</span>
                  <strong>{sourceFps}</strong>
                </div>
                <div className="technical-row">
                  <span>File size</span>
                  <strong>{formatBytes(file?.size ?? 0)}</strong>
                </div>
              </div>
              <div className="technical-group">
                <span className="technical-heading">Output</span>
                <div className="technical-row">
                  <span>Resolution</span>
                  <strong>{sourceResolution}</strong>
                </div>
                <div className="technical-row">
                  <span>FPS</span>
                  <strong>
                    {targetFps === "source" ? `${sourceFps} (Keep)` : `${targetFps} FPS`}
                  </strong>
                </div>
                <div className="technical-row">
                  <span>File size</span>
                  <strong>{formatBytes(compressedBytes)}</strong>
                </div>
                <div className="technical-row">
                  <span>Codec</span>
                  <strong>H.264 · yuv420p · MP4 faststart</strong>
                </div>
              </div>
            </div>

            <div className="size-readout" aria-live="polite">
              <div className="size-cell">
                <span className="size-caption">Original file</span>
                <span className="size-value" data-testid="text-original-size">
                  {formatBytes(file?.size ?? 0)}
                </span>
              </div>
              <span className="size-arrow" aria-hidden="true">
                →
              </span>
              <div className="size-cell">
                <span className="size-caption">After compression</span>
                <span
                  className={`size-value ${file ? "is-accent" : ""}`}
                  data-testid="text-compressed-size"
                >
                  {formatBytes(compressedBytes)}
                </span>
              </div>
            </div>

            <button
              className="button-lime compress-button"
              type="button"
              disabled={!file || flowState === "compressing"}
              onClick={startCompression}
              data-testid="button-compress"
            >
              <Zap size={17} aria-hidden="true" />
              {flowState === "compressing"
                ? "Optimizing video…"
                : "Run TikTok optimization"}
            </button>

            {flowState === "compressing" && (
              <div
                className="status-panel"
                role="status"
                data-testid="status-compressing"
              >
                <div className="status-row">
                  <span>{statusLabel}</span>
                  <strong>{progress}%</strong>
                </div>
                <div className="progress-track" aria-hidden="true">
                  <div
                    className="progress-fill"
                    style={{ width: `${progress}%` }}
                  />
                </div>
                <span className="status-note">
                  Keep this tab open — the work stays on your phone.
                </span>
              </div>
            )}

            {flowState === "complete" && (
              <div
                className="status-panel"
                role="status"
                data-testid="status-complete"
              >
                <div className="complete-note">
                  <Check size={16} strokeWidth={2.5} />
                  <span>Done. Your TikTok-ready file is ready.</span>
                </div>
                <div
                  className="download-file-meta"
                  data-testid="download-file-meta"
                >
                  <FileVideo size={14} aria-hidden="true" />
                  <span
                    className="download-file-name"
                    title={compressedFileName}
                  >
                    {compressedFileName}
                  </span>
                  <span className="download-file-size">
                    {formatBytes(compressedBlob?.size ?? compressedBytes)}
                  </span>
                </div>
                <button
                  className="button-lime mt-3 w-full"
                  type="button"
                  onClick={downloadCompressed}
                  disabled={!compressedBlob}
                  data-testid="button-download"
                >
                  <Download size={16} aria-hidden="true" />
                  Download compressed video
                </button>
                <button
                  className="button-outline mt-2 w-full"
                  type="button"
                  onClick={saveVideo}
                  disabled={!compressedBlob}
                  data-testid="button-save-video"
                >
                  <Share2 size={16} aria-hidden="true" />
                  Save video
                </button>
                <span className="download-hint">
                  MP4 · downloads go to Files &gt; Downloads
                </span>
                <p className="save-instruction" data-testid="save-instruction">
                  <strong>To show it in Gallery:</strong> open the downloaded
                  MP4 from Files, then choose <em>Share to Google Photos</em> or
                  move it to <em>DCIM/Camera</em>.
                </p>
                {saveMessage && (
                  <span className="save-message" role="status">
                    {saveMessage}
                  </span>
                )}
              </div>
            )}
          </div>
        </section>

        {error && (
          <div
            className="error-message"
            role="alert"
            data-testid="status-upload-error"
          >
            <TriangleAlert size={15} aria-hidden="true" />
            <span>{error}</span>
            <button
              className="ml-auto shrink-0 text-[#ff9e8c] transition-transform hover:scale-110"
              type="button"
              onClick={() => setError("")}
              aria-label="Dismiss error"
              data-testid="button-dismiss-error"
            >
              <X size={15} aria-hidden="true" />
            </button>
          </div>
        )}

        {file && flowState !== "compressing" && (
          <div className="flex justify-end pb-5 pt-1">
            <button
              className="font-mono-ui flex min-h-9 items-center gap-2 px-2 text-[10px] uppercase tracking-[0.08em] text-[#68736a] transition-colors hover:text-[#caff3d]"
              type="button"
              onClick={clearFile}
              data-testid="button-clear-video"
            >
              <X size={12} aria-hidden="true" />
              Clear selection
            </button>
          </div>
        )}

        <footer className="privacy-footer">
          <span>
            <strong>PRIVATE BY DEFAULT.</strong> Your video never leaves this
            browser.
          </span>
          <span>NEON / 2026</span>
        </footer>
      </div>
    </main>
  );
}

function Router() {
  return (
    <RoutedErrorBoundary>
      <Switch>
        <Route path="/" component={Home} />
        <Route component={NotFound} />
      </Switch>
    </RoutedErrorBoundary>
  );
}

function RoutedErrorBoundary({ children }: { children: ReactNode }) {
  const [location] = useLocation();
  return <ErrorBoundary resetKey={location}>{children}</ErrorBoundary>;
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, "")}>
          <Router />
        </WouterRouter>
        <Toaster />
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;
