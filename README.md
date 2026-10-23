# NEON REALLY COMPRESS

A browser-based video remux/optimization site based on the NEON V2 interface. Supabase login, payment UI, and server-side daily-limit checks have been removed. Video processing runs in the browser using FFmpeg.wasm.

## Deploy to GitHub Pages
1. Create a new repository named `NEON-REALLY-COMPRESS`.
2. Upload the contents of this folder to the repository root (not the ZIP itself).
3. In Settings → Pages, set the source to GitHub Actions.
4. Push to the `main` branch or run the workflow manually.

## Notes
- No Supabase account or keys are required.
- There is no server-enforced daily limit in this version.
- The current processing mode copies compatible streams without re-encoding; it does not sharpen or improve an already blurry source video.
- FFmpeg.wasm needs a modern browser and sufficient memory. Keep the page open while processing.
