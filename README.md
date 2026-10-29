# ClipKaro

Free, in-browser auto-subtitle reel clipper. Drop in one or many long videos and ClipKaro:

- writes **word-synced subtitles** with Whisper (GPU via WebGPU, CPU fallback), Hindi, English and 90+ languages
- cuts each video into back-to-back clips (15–90s) at natural pauses / sentence ends
- burns in reel-style captions and exports **MP4 (H.264/AAC), 1080×1920**, using hardware video encoding (WebCodecs), faster than real time
- processes a **queue of videos**, transcribing the next one while the current one exports, and saves each video's clips (plus an `.srt`) into its own folder

Nothing is uploaded; everything runs on the user's device. Best in Chrome or Edge on desktop.

Live: https://adityachaturvedi2906.github.io/clipkaro/

Files: `index.html` (UI), `app.js` (pipeline), `asr-worker.js` (speech-to-text). Built on [Mediabunny](https://mediabunny.dev) and [transformers.js](https://github.com/huggingface/transformers.js).

---
Shared with Harshita by the original author, Aditya Chaturvedi. Original: https://github.com/adityachaturvedi2906/clipkaro
