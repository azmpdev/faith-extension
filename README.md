# Operation Faith: AI Architect Link

This VS Code extension bridges your local workspace with **Operation Faith** running inside ComfyUI.  
It manages a secure Python listener process that the ComfyUI panel connects to via `localhost:1337`.

---

## Security Protocol

| Principle | Detail |
|---|---|
| **Workspace Isolation** | Runs exclusively from a local `.venv` — never touches your global Python. |
| **On-Demand** | The server only runs when you toggle Mode it on via the status bar. |
| **Local-Only** | All traffic stays on `localhost:1337`. No external network calls. |

---

## Quick Setup

### 1. Install the Extension

**Option A — Drag and drop:**  
Drag the `operation-faith-1.0.0.vsix` file into the VS Code Extensions panel.

**Option B — Command line:**
```
code --install-extension operation-faith-1.0.0.vsix
```

**Option C — Command Palette:**  
`Ctrl+Shift+P` → **Extensions: Install from VSIX…** → select the `.vsix` file.

### 2. Open Your Workspace

Open the folder that contains (or will contain) your `.venv`:

```
File → Open Folder → select your project root
```

### 3. Toggle the Agent On

Look at the **bottom-right** of the VS Code status bar.  
Click **`Faith: Offline`** to start the server.

### 4. Create .venv (First Time Only)

If no `.venv` exists, the extension will prompt:

> "No local .venv found. Create one for secure isolation?"

Click **"Yes, Create .venv"**.  
A terminal opens and runs:
```
python -m venv .venv
.venv\Scripts\activate        # (Windows)
source .venv/bin/activate     # (macOS/Linux)
pip install aiohttp
```

When the terminal finishes, click **`Faith: Offline`** again to start.

### 5. Connect from ComfyUI

1. Open ComfyUI in your browser.
2. In the **Operation Faith** panel (top-right), enter `http://localhost:1337` in the URL field.
3. Click **Connect Agent**.
4. The panel should show **"Connected"** and all controls become active.

---

## Status Bar States

| Icon | State | Meaning |
|---|---|---|
| `$(circle-outline)` | **Faith: Offline** | Server not running. Click to start. |
| `$(loading~spin)` | **Faith: Starting…** | Server is booting, health-check pending. |
| `$(circle-filled)` | **Faith: Online** | Server alive and accepting connections. |

---

## Commands

Open the Command Palette (`Ctrl+Shift+P`) and type `Operation Faith`:

| Command | Action |
|---|---|
| **Toggle Agent Server** | Start or stop the listener process. |
| **Show Server Log** | Open the output channel with server logs. |

---

## Settings

`File → Preferences → Settings → Extensions → Operation Faith`

| Setting | Default | Description |
|---|---|---|
| `operationFaith.port` | `1337` | Port for the listener. |
| `operationFaith.host` | `127.0.0.1` | Bind address. |

---

## Features Unlocked via Operation Faith

Once connected, the ComfyUI panel gains access to:

- **Forge Node** — Let the agent program custom ComfyUI nodes on the fly.
- **Visual Critique** — Real-time heuristic feedback on AI-generated images.
- **Pipeline Export** — Automatic material/texture syncing with Unity or Blender projects.
- **Specialist Swarm** — Switch between expert personas (Shader Wizard, Texture Artist, etc.).
- **Live-Link Relay** — WebSocket bridge to push asset updates to game engines in real time.
- **Autonomous Optimizer** — Auto-detect slow nodes and suggest latency reduction strategies.

---

## Build from Source

If you want to rebuild the `.vsix` yourself:

```bash
cd faith-extension
npm install
npm run compile
npx @vscode/vsce package
```

This produces `operation-faith-1.0.0.vsix` in the `faith-extension/` folder.

---

## Troubleshooting

| Problem | Fix |
|---|---|
| "Faith: Offline" won't toggle on | Ensure a workspace folder is open. |
| ".venv not found" prompt keeps appearing | Run `python -m venv .venv` manually in your project root. |
| Health-check times out | Check the **Operation Faith** output channel (`Ctrl+Shift+P` → Show Server Log). |
| Port 1337 already in use | Change `operationFaith.port` in settings, and update the ComfyUI panel URL to match. |
| ComfyUI says "Could not reach agent" | Make sure the status bar shows **Faith: Online** before clicking Connect. |

---

# faith-extension

VS Code extension for Operation Faith. Workflow validation, agent passthrough, and developer-grade logging for ComfyUI.

## Features
- VS Code integration for Operation Faith
- Workflow validation and error feedback
- Agent passthrough (no hardcoded replies)
- Mode selector for user intent routing
- Developer-focused logging and diagnostics

## Requirements
- ComfyUI-Operation-Faith (custom node)
- ComfyUI (base system)

## License
MIT License

## Installation
Clone the repo and follow the instructions in the documentation.

## Usage
See FAITH_CONSTITUTION.md and PROJECT_CONTEXT.md for protocol and workflow details.
