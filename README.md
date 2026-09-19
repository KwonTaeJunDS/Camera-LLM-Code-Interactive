# Camera → LLM → Code → Interactive

A local multimodal web experiment that turns one webcam snapshot into four interactive p5.js worlds.

The browser captures an image, Gemini interprets it and generates p5.js code, and MediaPipe hand tracking lets you interact with the result in real time.

## Stack

- React 19 + TypeScript + Vite
- Gemini API for image-to-code generation
- MediaPipe Hand Landmarker for local hand tracking
- p5.js for generated visuals

## Run locally

### Requirements

- Node.js 24 or newer
- A webcam
- A Gemini API key
- Chrome or Edge

### Setup

```bash
git clone https://github.com/KwonTaeJunDS/Camera-LLM-Code-Interactive.git
cd Camera-LLM-Code-Interactive
npm install
```

Create `.env.local` in the project root:

```env
GEMINI_API_KEY=your_api_key_here
```

Start the local app:

```bash
npm run dev
```

Open [http://127.0.0.1:3000](http://127.0.0.1:3000) and allow camera access.

The first run downloads the MediaPipe hand model and prepares local p5.js and MediaPipe assets. The app and hand tracking run locally, while captured snapshots are sent to Gemini only when you capture, retry, or re-imagine a frame.

## Project structure

```text
.
├── components/       # Camera, world frames, and sandboxed p5.js preview
├── hooks/            # Webcam, hand tracking, and generation state
├── lib/              # Shared world, interaction, and runtime logic
├── server/           # Local Gemini API middleware and prompts
├── workers/          # MediaPipe hand-tracking worker
├── scripts/          # Local asset setup and optional smoke test
├── tests/            # Unit and browser integration fixtures
├── Home.tsx          # Main experience
├── index.tsx         # React entry point
├── index.css         # Minimal responsive layout
├── vite.config.ts    # Vite server and local API configuration
└── package.json
```

## Notes

- The Gemini API key stays on the local Vite server and is not bundled into the browser.
- Live webcam video and hand-tracking frames are not streamed to Gemini.
- This repository is configured for local use only and does not include deployment setup.

## License

See [LICENSE](LICENSE) and the license headers in the source files.
