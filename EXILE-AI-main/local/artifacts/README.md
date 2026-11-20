# EXILE Artifact Engine

Creates, validates, stores, previews, versions, converts and delivers real files. Specs are declarative; no model-written code is executed.

**Formats:** PDF, DOCX, TXT, MD, RTF, HTML, XLSX, CSV, JSON, XML, PPTX, ZIP, PNG/JPG/WebP/SVG, WAV/MP3/OGG/M4A, MP4/WebM.
Each file is read back and validated before it is saved; checks that can't run (missing engine) are reported as skipped.

**API** (loopback only, mounted at `/artifacts`): `GET /capabilities /  /:id /:id/preview /:id/download`, `POST / /package /ai-image /:id/edit /:id/convert /:id/variations /:id/deliver`, `DELETE /:id?confirm=<id>`. Send `Accept: text/event-stream` for real stage progress.

**Environment variables**
- `EXILE_ARTIFACT_DIR` store location (default `<data>/.exile-ai/artifacts`)
- `EXILE_ARTIFACT_AI_PROVIDER` force a text provider; `EXILE_GEMINI_FREE_TIER=true` allows Gemini (free-tier policy)
- `EXILE_LOCAL_AUTH_SECRET` require `x-exile-local-auth` on API calls
- `EXILE_FFMPEG`, `EXILE_SOFFICE` tool paths; `EXILE_WHISPER_CLI` + `EXILE_WHISPER_MODEL` transcription; `EXILE_SD_CLI` + `EXILE_SD_MODEL` local Stable Diffusion
- `EXILE_ARTIFACT_DEEP_RENDER=0` skip LibreOffice render checks

**Limits / honesty:** no cloud image/audio/video generation provider; TTS and transcription need local engines; background removal handles solid backgrounds only; WhatsApp accepts image, PDF, text, CSV, Office and audio up to 15 MB (video/md/json/xml/html/rtf/zip/svg are kept but not sendable). Delivery is "sent" only when the sender confirms.

Tests: `npm test` (see `test/artifacts.test.mjs`).
