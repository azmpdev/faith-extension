import * as vscode from 'vscode';
import { spawn, ChildProcess } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import * as http from 'http';

// Shared Utils (CommonJS)
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { googleSearchLink } = require('./assets/agent_utils');

let serverProcess: ChildProcess | null = null;
let statusItem: vscode.StatusBarItem;
let outputChannel: vscode.OutputChannel;
let logFileStream: fs.WriteStream | null = null;
let logDir: string = '';

// ──────────── AI Bridge State ─────────────────────────────────────────

let aiBridgeActive = false;
let aiBridgeInterval: ReturnType<typeof setInterval> | null = null;
let processedSupportIds: Set<string> = new Set();
let activeLlm: vscode.LanguageModelChat | null = null;
let bridgeProcessing = false; // guard against overlapping polls
let allSafeModels: Map<string, vscode.LanguageModelChat> = new Map(); // family → model

// ──────────── Activation ──────────────────────────────────────────────

export function activate(context: vscode.ExtensionContext): void {
    outputChannel = vscode.window.createOutputChannel('Operation Faith');

    // ── Centralized file logging → LOGS/vscode_extension.log ──
    const wsFolders = vscode.workspace.workspaceFolders;
    if (wsFolders) {
        logDir = path.join(wsFolders[0].uri.fsPath, 'LOGS');
        if (!fs.existsSync(logDir)) { fs.mkdirSync(logDir, { recursive: true }); }
        const logPath = path.join(logDir, 'vscode_extension.log');
        
        // ── Log Rotation (10MB limit, 5 backups) ──
        try {
            if (fs.existsSync(logPath)) {
                const stats = fs.statSync(logPath);
                if (stats.size > 10 * 1024 * 1024) { // 10MB
                    rotateLog(logPath, 5);
                }
            }
            // Cleanup old logs (>7 days)
            cleanupOldLogs(logDir, 7);
        } catch (e) { console.error('Log rotation failed:', e); }

        try {
            logFileStream = fs.createWriteStream(logPath, { flags: 'a' });
            logFileStream.on('error', () => { logFileStream = null; });
        } catch { logFileStream = null; }
    }

    statusItem = vscode.window.createStatusBarItem(
        vscode.StatusBarAlignment.Right,
        100,
    );
    statusItem.text = '$(circle-outline) Faith: Offline';
    statusItem.tooltip = 'Click to toggle the Operation Faith agent server';
    statusItem.command = 'operation-faith.toggleServer';
    statusItem.show();

    context.subscriptions.push(
        statusItem,
        outputChannel,
        vscode.commands.registerCommand('operation-faith.toggleServer', () => {
            serverProcess ? stopServer() : startServer(context);
        }),
        vscode.commands.registerCommand('operation-faith.showLog', () => {
            outputChannel.show(true);
        }),
        vscode.commands.registerCommand('operation-faith.enableAIBridge', () => {
            enableAIBridge();
        }),
        vscode.commands.registerCommand('operation-faith.disableAIBridge', () => {
            disableAIBridge();
        }),
        vscode.commands.registerCommand('operation-faith.setupEnvironment', async () => {
            const workspaceFolders = vscode.workspace.workspaceFolders;
            if (!workspaceFolders) {
                vscode.window.showWarningMessage('Operation Faith requires an open workspace folder.');
                return;
            }
            const rootPath = workspaceFolders[0].uri.fsPath;
            await createVenv(rootPath);
            vscode.window.showInformationMessage('Environment setup started. When finished, use the Faith status bar icon or "Operation Faith: Toggle Server" command to start/stop the listener.');
        })
    );

    log('Operation Faith extension activated.');
}

export function deactivate(): void {
    disableAIBridge();
    stopServer();
    if (logFileStream) { logFileStream.end(); logFileStream = null; }
}

// ──────────── Helpers ─────────────────────────────────────────────────

// ── Per-request log buffer for Send_Collection ──
let _requestLogBuffer: string[] | null = null;

function log(message: string): void {
    const ts = new Date().toISOString();
    const line = `[${ts}]  ${message}`;
    outputChannel.appendLine(line);
    if (logFileStream) { logFileStream.write(line + '\n'); }
    if (_requestLogBuffer) { _requestLogBuffer.push(line); }
}

function getConfig<T>(key: string, fallback: T): T {
    return vscode.workspace.getConfiguration('operationFaith').get<T>(key, fallback);
}

/**
 * Resolve the Python interpreter path.
 * SECURITY: Only uses workspace .venv for isolation.
 * Never falls back to global Python or system-wide interpreters.
 */
function resolvePythonPath(rootPath: string): string | null {
    const isWin = process.platform === 'win32';

    // ONLY use workspace .venv - no fallbacks for security
    const venvPython = isWin
        ? path.join(rootPath, '.venv', 'Scripts', 'python.exe')
        : path.join(rootPath, '.venv', 'bin', 'python');
    
    if (fs.existsSync(venvPython)) {
        return venvPython;
    }

    // No .venv found - caller will prompt to create one
    return null;
}

// ──────────── Server Lifecycle ────────────────────────────────────────

async function startServer(context: vscode.ExtensionContext): Promise<void> {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders) {
        vscode.window.showWarningMessage(
            'Operation Faith requires an open workspace folder.',
        );
        return;
    }

    const rootPath = workspaceFolders[0].uri.fsPath;
    log(`Workspace root: ${rootPath}`);
    const pythonPath = resolvePythonPath(rootPath);

    // ── Reset vscode_extension.log on listener start ──
    const logPath = path.join(rootPath, 'LOGS', 'vscode_extension.log');
    try {
        if (fs.existsSync(logPath)) {
            fs.unlinkSync(logPath);
        }
        logFileStream = fs.createWriteStream(logPath, { flags: 'a' });
        logFileStream.on('error', () => { logFileStream = null; });
    } catch { logFileStream = null; }

    if (pythonPath) {
        log(`Python resolved: ${pythonPath}`);
    } else {
        log('No Python interpreter found (.venv or ms-python).');
    }

    if (!pythonPath) {
        const choice = await vscode.window.showErrorMessage(
            'No local .venv found. Create one for secure isolation?',
            'Yes, Create .venv',
            'Cancel',
        );
        if (choice === 'Yes, Create .venv') {
            await createVenv(rootPath);
        }
        return;
    }

    // Ensure aiohttp is installed
    const requirementsPath = path.join(
        context.extensionPath,
        'scripts',
        'requirements.txt',
    );
    if (fs.existsSync(requirementsPath)) {
        await installDeps(pythonPath, requirementsPath);
    }

    const scriptPath = path.join(
        context.extensionPath,
        'scripts',
        'faith_listener.py',
    );
    if (!fs.existsSync(scriptPath)) {
        vscode.window.showErrorMessage(
            `faith_listener.py not found at ${scriptPath}`,
        );
        return;
    }

    const port = getConfig<number>('port', 1337);
    const host = getConfig<string>('host', '127.0.0.1');

    // ── Single-instance guard: refuse to spawn if port is occupied ────
    const alreadyRunning = await pingHealth(host, port);
    if (alreadyRunning) {
        log(`Port ${port} is already in use.`);
        const choice = await vscode.window.showWarningMessage(
            `Faith Agent: port ${port} is already occupied. Would you like to kill the existing listener and start a new one?`,
            'Yes, Kill and Restart',
            'Cancel'
        );
        if (choice === 'Yes, Kill and Restart') {
            await killProcessOnPort(port);
            await delay(1000);
            // Try again after killing
            if (await pingHealth(host, port)) {
                vscode.window.showErrorMessage('Failed to kill existing listener. Please check manually.');
                return;
            }
        } else {
            return;
        }
    }

    log(`Host: ${host} | Port: ${port}`);
    log(`Script: ${scriptPath}`);
    log(`Starting agent server: ${pythonPath} ${scriptPath} --port ${port} --workspace "${rootPath}"`);
    outputChannel.show(true);

    serverProcess = spawn(pythonPath, [scriptPath, '--port', String(port), '--workspace', rootPath], {
        cwd: rootPath,
        env: { ...process.env },
    });

    serverProcess.stdout?.on('data', (data: Buffer) => {
        log(data.toString().trim());
    });

    serverProcess.stderr?.on('data', (data: Buffer) => {
        log(`[stderr] ${data.toString().trim()}`);
    });

    serverProcess.on('error', (err: Error) => {
        log(`Server process error: ${err.message}`);
        vscode.window.showErrorMessage(`Faith Agent failed to start: ${err.message}`);
        serverProcess = null;
        setStatusOffline();
    });

    serverProcess.on('exit', (code: number | null) => {
        log(`Server process exited with code ${code}`);
        serverProcess = null;
        setStatusOffline();
    });

    // Wait briefly, then health-check
    await delay(1500);
    const alive = await pingHealth(host, port);
    if (alive) {
        setStatusOnline();
        log(`Agent listener is live on http://${host}:${port}`);
        vscode.window.showInformationMessage(
            `Faith Agent is running securely on http://${host}:${port}`,
        );
        // Auto-enable AI Bridge once server is confirmed alive
        await enableAIBridge();
    } else {
        log('Health-check failed after startup — server may still be loading.');
        statusItem.text = '$(loading~spin) Faith: Starting…';
        // Retry once more after a longer delay
        await delay(3000);
        if (await pingHealth(host, port)) {
            setStatusOnline();
            log(`Agent listener confirmed alive on retry at http://${host}:${port}`);
            vscode.window.showInformationMessage(
                `Faith Agent is running securely on http://${host}:${port}`,
            );
            // Auto-enable AI Bridge once server is confirmed alive
            await enableAIBridge();
        } else {
            vscode.window.showWarningMessage(
                'Faith Agent started but health-check timed out. Check the output log.',
            );
            setStatusOffline();
        }
    }
}

function stopServer(): void {
    if (serverProcess) {
        disableAIBridge(); // Always disable bridge before stopping server
        log('Stopping agent server…');
        serverProcess.kill();
        serverProcess = null;
        setStatusOffline();
        vscode.window.showInformationMessage('Faith Agent stopped.');
    }
}

// ──────────── venv Bootstrap ──────────────────────────────────────────

async function createVenv(rootPath: string): Promise<void> {
    const terminal = vscode.window.createTerminal('Faith Setup');
    terminal.show();

    const isWin = process.platform === 'win32';
    const activateCmd = isWin
        ? '.venv\\Scripts\\activate'
        : 'source .venv/bin/activate';

    terminal.sendText(`cd "${rootPath}"`);
    terminal.sendText('python -m venv .venv');
    terminal.sendText(activateCmd);
    terminal.sendText('pip install aiohttp');
    vscode.window.showInformationMessage(
        'Creating .venv — when the terminal finishes, use the Faith status bar icon or "Operation Faith: Toggle Server" command to start/stop the listener.'
    );
}

async function killProcessOnPort(port: number): Promise<void> {
    const isWin = process.platform === 'win32';
    let cmd = '';
    if (isWin) {
        // Windows: find PID using netstat and taskkill
        cmd = `for /f "tokens=5" %a in ('netstat -aon | findstr :${port}') do taskkill /F /PID %a`;
    } else {
        // Unix: kill process using lsof
        cmd = `kill -9 $(lsof -t -i:${port})`;
    }
    const terminal = vscode.window.createTerminal('Faith Kill Listener');
    terminal.show();
    terminal.sendText(cmd);
    vscode.window.showInformationMessage(`Attempting to kill process on port ${port}.`);
// ...existing code...
}

async function installDeps(
    pythonPath: string,
    requirementsPath: string,
): Promise<void> {
    return new Promise<void>((resolve) => {
        const proc = spawn(pythonPath, ['-m', 'pip', 'install', '-q', '-r', requirementsPath]);
        proc.on('close', () => resolve());
        proc.on('error', () => resolve()); // best-effort
    });
}

// ──────────── Status Bar ─────────────────────────────────────────────

function setStatusOnline(): void {
    statusItem.text = '$(circle-filled) Faith: Online';
    statusItem.color = new vscode.ThemeColor('statusBarItem.remoteBackground');
}

function setStatusOffline(): void {
    statusItem.text = '$(circle-outline) Faith: Offline';
    statusItem.color = undefined;
}

// ──────────── Utilities ──────────────────────────────────────────────

function delay(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
}

function pingHealth(host: string, port: number): Promise<boolean> {
    return new Promise((resolve) => {
        const req = http.get(`http://${host}:${port}/health`, (res) => {
            resolve(res.statusCode === 200);
        });
        req.on('error', () => resolve(false));
        req.setTimeout(3000, () => {
            req.destroy();
            resolve(false);
        });
    });
}

// ──────────── HTTP Helpers ────────────────────────────────────────────

function httpGet(url: string): Promise<string> {
    return new Promise((resolve, reject) => {
        const req = http.get(url, (res) => {
            let data = '';
            res.on('data', (chunk: Buffer) => { data += chunk.toString(); });
            res.on('end', () => resolve(data));
        });
        req.on('error', reject);
        req.setTimeout(5000, () => { req.destroy(); reject(new Error('timeout')); });
    });
}

function httpPost(url: string, body: Record<string, unknown>): Promise<string> {
    return new Promise((resolve, reject) => {
        const postData = JSON.stringify(body);
        const parsed = new URL(url);
        const req = http.request({
            hostname: parsed.hostname,
            port: parsed.port,
            path: parsed.pathname,
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(postData),
            },
        }, (res) => {
            let data = '';
            res.on('data', (chunk: Buffer) => { data += chunk.toString(); });
            res.on('end', () => resolve(data));
        });
        req.on('error', reject);
        req.setTimeout(10000, () => { req.destroy(); reject(new Error('timeout')); });
        req.write(postData);
        req.end();
    });
}

// ──────────── AI Bridge ──────────────────────────────────────────────

// Cost tier mapping — HARD CAP: nothing over 3x EVER
const MODEL_COST_MAP: Record<string, { multiplier: number; label: string }> = {
    // ── 0x — FREE (no premium cost) ──
    'gpt-4o-mini':           { multiplier: 0,    label: '0x' },
    'gpt-4o':                { multiplier: 0,    label: '0x' },
    'gpt-4.1':               { multiplier: 0,    label: '0x' },
    'gpt-5-mini':            { multiplier: 0,    label: '0x' },
    'raptor-mini':           { multiplier: 0,    label: '0x' },   // Raptor mini
    'oswe-vscode':           { multiplier: 0,    label: '0x' },   // Raptor mini alt family
    // ── 0.25x ──
    'grok-code':             { multiplier: 0.25, label: '0.25x' },
    // ── 0.33x ──
    'claude-haiku-4.5':      { multiplier: 0.33, label: '0.33x' },
    'gemini-3-flash':        { multiplier: 0.33, label: '0.33x' },
    'gpt-5.1-codex-mini':    { multiplier: 0.33, label: '0.33x' },
    // ── 1x ──
    'claude-sonnet-4':       { multiplier: 1,    label: '1x' },
    'claude-sonnet-4.5':     { multiplier: 1,    label: '1x' },
    'claude-sonnet-4.6':     { multiplier: 1,    label: '1x' },
    'gemini-2.5-pro':        { multiplier: 1,    label: '1x' },
    'gemini-3-pro':          { multiplier: 1,    label: '1x' },
    'gpt-5':                 { multiplier: 1,    label: '1x' },
    'gpt-5-codex':           { multiplier: 1,    label: '1x' },
    'gpt-5.1':               { multiplier: 1,    label: '1x' },
    'gpt-5.1-codex':         { multiplier: 1,    label: '1x' },
    'gpt-5.1-codex-max':     { multiplier: 1,    label: '1x' },
    'gpt-5.2':               { multiplier: 1,    label: '1x' },
    'gpt-5.2-codex':         { multiplier: 1,    label: '1x' },
    'gpt-5.3-codex':         { multiplier: 1,    label: '1x' },
    // ── 3x — upper limit (still allowed) ──
    'claude-opus-4.5':       { multiplier: 3,    label: '3x' },
    'claude-opus-4.6':       { multiplier: 3,    label: '3x' },
    // ── BLOCKED — over 3x, NEVER allowed ──
    'claude-opus-4.1':       { multiplier: 10,   label: '10x BLOCKED' },
    'claude-opus-4.6-fast':  { multiplier: 30,   label: '30x BLOCKED' },
    'copilot-fast':          { multiplier: 999,  label: 'BLOCKED' },  // internal duplicate
};

const MAX_ALLOWED_MULTIPLIER = 3;

function getModelCost(family: string): { multiplier: number; label: string } {
    return MODEL_COST_MAP[family] || { multiplier: 999, label: 'UNKNOWN-BLOCKED' };
}

// ──────────── Send Collection Log ────────────────────────────────────
// Captures every log() line during a request and appends to
// LOGS/Send_Collection/<mode>.log  (e.g. build.log, ask.log, fix.log)
// Each request is separated by a blank line for readability.

function flushRequestLog(mode: string): void {
    if (!logDir || !_requestLogBuffer || _requestLogBuffer.length === 0) {
        _requestLogBuffer = null;
        return;
    }
    try {
        const sendDir = path.join(logDir, 'Send_Collection');
        if (!fs.existsSync(sendDir)) { fs.mkdirSync(sendDir, { recursive: true }); }

        const safeMode = mode.replace(/[^a-z0-9_-]/gi, '_') || 'unknown';
        const logPath = path.join(sendDir, `${safeMode}.log`);

        // Append buffer + blank separator line
        const block = _requestLogBuffer.join('\n') + '\n\n';
        fs.appendFileSync(logPath, block, 'utf-8');
        log(`AI Bridge: Request log flushed → ${safeMode}.log (${_requestLogBuffer.length} lines)`);
    } catch (err) {
        log(`AI Bridge: ⚠ Failed to flush request log: ${err}`);
    }
    _requestLogBuffer = null;
}

// ──────────── Workflow Log ────────────────────────────────────────────
// Saves each agent-generated workflow to LOGS/last_agent_workflow.json
// so the user (or the AI assistant) can inspect it with "check the workflow".

function saveWorkflowLog(
    workflow: Record<string, unknown>,
    supportId: string,
    mode: string,
    modelUsed: string,
    source: 'initial' | 'self-corrected' | 'preflight',
): void {
    if (!logDir) { return; }
    try {
        const logEntry = {
            timestamp: new Date().toISOString(),
            support_id: supportId,
            mode,
            model_used: modelUsed,
            source,
            node_count: Array.isArray(workflow.nodes) ? (workflow.nodes as any[]).length : 0,
            link_count: Array.isArray(workflow.links) ? (workflow.links as any[]).length : 0,
            workflow,
        };
        const logPath = path.join(logDir, 'last_agent_workflow.json');
        fs.writeFileSync(logPath, JSON.stringify(logEntry, null, 2), 'utf-8');
        log(`AI Bridge: Workflow log saved to ${logPath} (${source})`);
    } catch (err) {
        log(`AI Bridge: ⚠ Failed to save workflow log: ${err}`);
    }
}

const SYSTEM_PROMPT_BASE = `You are the Resident Architect for Operation Faith — an AI agent bridge connecting ComfyUI (a node-based image/video generation tool) with VS Code.

A user has sent a message through the ComfyUI support panel. Your response will be displayed in the ComfyUI panel.

RULES (Faith Constitution):
- You are the Brain; the listener is just the nervous system moving data.
- Use active, technical verbs: "Patching", "Routing", "Initializing", "Deploying".
- Never reference templates or hardcoded workflows — reason from scratch.
- Understand the "Why" behind requests, not just keywords.
- Be concise but helpful. The user sees your response in a small chat panel.`;

const COMFYUI_WORKFLOW_FORMAT = `
COMFYUI WORKFLOW JSON FORMAT:
A ComfyUI workflow is a JSON object with these top-level keys:
  last_node_id: highest node id number
  last_link_id: highest link id number
  nodes: array of node objects
  links: array of link arrays
  groups: [] (optional)
  config: {} (optional)
  extra: {} (optional)
  version: 0.4

NODE OBJECT:
  {
    "id": <unique integer>,
    "type": "<ComfyUI node class name>",
    "pos": [x, y],
    "size": [width, height],
    "flags": {},
    "order": <execution order integer starting from 0>,
    "mode": 0,
    "inputs": [<array of input objects — see INPUT OBJECT below>],
    "outputs": [<array of output objects — see OUTPUT OBJECT below>],
    "properties": {"Node name for S&R": "<same as type>"},
    "widgets_values": [<values for widget controls in order>]
  }

INPUT OBJECT — CRITICAL: Use the exact input NAMES shown below, NOT the type names:
  Connected input:  {"name": "<input name>", "type": "<DATA_TYPE>", "link": <link_id>}
  Widget input:     {"name": "<widget name>", "type": "<DATA_TYPE>", "widget": {"name": "<widget name>"}, "link": null}
  Unconnected input: {"name": "<input name>", "type": "<DATA_TYPE>", "link": null}

OUTPUT OBJECT:
  {"name": "<output name>", "type": "<DATA_TYPE>", "slot_index": <0-based index>, "links": [<link_ids>]}

LINK ARRAY FORMAT: [link_id, source_node_id, source_output_slot, target_node_id, target_input_slot, "<DATA_TYPE>"]
  - source_output_slot: 0-based index into the source node's "outputs" array
  - target_input_slot: 0-based index into the target node's "inputs" array (counting ONLY connectable inputs, NOT widget-only inputs)
  - For nodes with widget inputs listed in the inputs array, the target_input_slot counts from the FIRST connectable input

CRITICAL WIRING RULES:
  1. Every link_id in a node's input "link" field MUST have a matching entry in the top-level "links" array
  2. Every link_id in a node's output "links" array MUST have a matching entry in the top-level "links" array
  3. The target_input_slot in links must match the POSITION of that input in the target node's inputs array
  4. Input names are LOWERCASE descriptive names (e.g. "images", "model", "clip", "samples", "vae", "positive", "negative", "latent_image")
  5. Output names are UPPERCASE type names (e.g. "MODEL", "CLIP", "VAE", "LATENT", "IMAGE", "CONDITIONING")
  6. Always use modern, current node types. Never use deprecated nodes — use their modern replacements (e.g. CheckpointLoaderSimple instead of CheckpointLoader, ControlNetApplyAdvanced instead of ControlNetApply). The system will auto-detect and offer replacements for any deprecated nodes.

COMMON NODE TYPES WITH EXACT INPUT/OUTPUT NAMES:
  CheckpointLoaderSimple:
    inputs: (widget) ckpt_name
    outputs: MODEL (slot 0), CLIP (slot 1), VAE (slot 2)
    widgets_values: ["model.safetensors"]

  UnetLoaderGGUFAdvanced:
    inputs: (widget) unet_name, dequant_dtype, patch_dtype, patch_on_device
    outputs: MODEL (slot 0)
    widgets_values: ["model.gguf", "bfloat16", "default", false]

  CLIPLoader:
    inputs: (widget) clip_name, type [stable_diffusion|stable_cascade|sd3|stable_audio|mochi|ltxv|pixart|cosmos|lumina2|wan|hidream|chroma|ace|omnigen2|qwen_image|hunyuan_image|flux2|ovis], device
    outputs: CLIP (slot 0)
    widgets_values: ["clip.safetensors", "stable_diffusion", "default"]
    IMPORTANT: FLUX2 uses CLIPLoader with type="flux2" and a single Mistral-Small encoder. FLUX1 does NOT use CLIPLoader — it uses DualCLIPLoader with type="flux".

  CLIPTextEncode:
    inputs: clip (slot 0, type CLIP), (widget) text
    outputs: CONDITIONING (slot 0)
    widgets_values: ["prompt text"]

  KSampler:
    inputs: model (slot 0), positive (slot 1), negative (slot 2), latent_image (slot 3), (widgets) seed, control_after_generate, steps, cfg, sampler_name, scheduler, denoise
    outputs: LATENT (slot 0)
    widgets_values: [<seed_integer>, "<fixed|randomize>", <steps_int>, <cfg_float>, "<sampler_name>", "<scheduler>", <denoise_float>]
    FIELD ORDER: seed, control_after_generate, steps, cfg, sampler_name, scheduler, denoise — always in this exact order

  EmptyLatentImage:
    inputs: (widgets) width, height, batch_size
    outputs: LATENT (slot 0)
    widgets_values: [width, height, 1]

  VAELoader:
    inputs: (widget) vae_name
    outputs: VAE (slot 0)
    widgets_values: ["vae.safetensors"]

  VAEDecode:
    inputs: samples (slot 0, type LATENT), vae (slot 1, type VAE)
    outputs: IMAGE (slot 0)
    widgets_values: []

  LoraLoaderModelOnly:
    inputs: model (slot 0, type MODEL), (widgets) lora_name, strength_model
    outputs: MODEL (slot 0)
    widgets_values: ["lora.safetensors", 1.0]

  PreviewImage:
    inputs: images (slot 0, type IMAGE)  ← NOTE: input name is "images" not "IMAGE"
    outputs: none
    widgets_values: []

  SaveImage:
    inputs: images (slot 0, type IMAGE), (widget) filename_prefix  ← NOTE: input name is "images" not "IMAGE"
    outputs: none
    widgets_values: ["prefix"]

  ControlNetLoader:
    inputs: (widget) control_net_name
    outputs: CONTROL_NET (slot 0)
    widgets_values: ["controlnet.safetensors"]

  ControlNetApplyAdvanced:
    inputs: positive (slot 0, type CONDITIONING), negative (slot 1, type CONDITIONING), control_net (slot 2, type CONTROL_NET), image (slot 3, type IMAGE), (widgets) strength, start_percent, end_percent
    outputs: CONDITIONING (slot 0, modified positive), CONDITIONING (slot 1, modified negative)
    widgets_values: [<strength_float>, <start_percent_float>, <end_percent_float>]
    FIELD ORDER: strength, start_percent, end_percent — always in this exact order
    CRITICAL: This node takes CONDITIONING + CONTROL_NET + IMAGE in and outputs modified CONDITIONING.
    Wire: CLIPTextEncode → ControlNetApplyAdvanced → KSampler (for ControlNet workflows).

  LoraLoader:
    inputs: model (slot 0, type MODEL), clip (slot 1, type CLIP), (widgets) lora_name, strength_model, strength_clip
    outputs: MODEL (slot 0), CLIP (slot 1)
    widgets_values: ["lora.safetensors", 1.0, 1.0]

  DualCLIPLoader:
    inputs: (widget) clip_name1, clip_name2, type [sdxl|sd3|flux|hunyuan_video|hidream|hunyuan_image|hunyuan_video_15|kandinsky5|kandinsky5_image|ltxv|newbie|ace]
    outputs: CLIP (slot 0)
    widgets_values: ["clip1.safetensors", "clip2.safetensors", "sdxl"]
    Recipes: sdxl=clip-l+clip-g, sd3=clip-l+clip-g or clip-l+t5 or clip-g+t5, flux=clip-l+t5 (for FLUX1 only, NOT FLUX2).

  CLIPLoaderGGUF:
    inputs: (widget) clip_name
    outputs: CLIP (slot 0)
    widgets_values: ["clip.gguf"]

  LoadImage:
    inputs: (widget) image
    outputs: IMAGE (slot 0), MASK (slot 1)
    widgets_values: ["image.png"]

  DWPreprocessor:
    inputs: image (slot 0, type IMAGE)
    outputs: IMAGE (slot 0, the pose skeleton), POSE_KEYPOINT (slot 1)
    widgets_values: [true, true, true, 512, "yolox_l.onnx", "dw-ll_ucoco_384_bs5.torchscript.pt"]
    NOTE: This preprocessor extracts pose skeletons from images. Feed its IMAGE output (slot 0) to ControlNetApplyAdvanced.image.

    SetUnionControlNetType:
    inputs: control_net (slot 0, type CONTROL_NET)
    outputs: CONTROL_NET (slot 0)
    widgets_values: ["openpose"]
    VALID type values: "openpose", "depth", "hed/pidi/scribble", "canny/lineart/anime_lineart/mlsd", "normal", "segment", "tile", "repaint"
    NOTE: Required when using a Union ControlNet model. Place between ControlNetLoader and ControlNetApplyAdvanced.

NODE CONNECTION TYPE RULES — WHAT CONNECTS TO WHAT:
  MODEL outputs → model inputs ONLY (KSampler.model, LoraLoader.model, ControlNetApplyAdvanced is NOT a model input)
  CLIP outputs → clip inputs ONLY (CLIPTextEncode.clip, LoraLoader.clip, CLIPSetLastLayer.clip)
  CONDITIONING outputs → positive/negative inputs ONLY (KSampler.positive, KSampler.negative, ControlNetApplyAdvanced.positive, ControlNetApplyAdvanced.negative)
  LATENT outputs → samples/latent_image inputs ONLY (KSampler.latent_image, VAEDecode.samples)
  VAE outputs → vae inputs ONLY (VAEDecode.vae, VAEEncode.vae)
  IMAGE outputs → images/image inputs ONLY (PreviewImage.images, SaveImage.images, ControlNetApplyAdvanced.image, VAEEncode.pixels)
  CONTROL_NET outputs → control_net inputs ONLY (ControlNetApplyAdvanced.control_net)
  CLIPLoader, CLIPLoaderGGUF, DualCLIPLoader, VAELoader, ControlNetLoader, UnetLoaderGGUFAdvanced, UNETLoader have NO connectable inputs — do NOT send any links to them.

OPTIONAL CONTROLNET WIRING PATTERN (only when explicitly requested by the CURRENT user message):
    Do NOT add ControlNet, DWPreprocessor, or SetUnionControlNetType unless the current request explicitly asks for ControlNet/pose/reference guidance.
    If user explicitly asks for DW Pose / OpenPose ControlNet, include a DWPreprocessor node.
    If using a Union ControlNet model, include a SetUnionControlNetType node.

  FULL CHAIN for DW Pose with Union ControlNet:
  1. LoadImage.output[0] (IMAGE) → DWPreprocessor.input "image" (slot 0)
  2. DWPreprocessor.output[0] (IMAGE, the pose skeleton) → ControlNetApplyAdvanced.input "image" (slot 3)
    3. ControlNetLoader.output[0] (CONTROL_NET) → SetUnionControlNetType.input "control_net" (slot 0)
    4. SetUnionControlNetType.output[0] (CONTROL_NET) → ControlNetApplyAdvanced.input "control_net" (slot 2)
  5. CLIPTextEncode(positive).output[0] → ControlNetApplyAdvanced.input "positive" (slot 0)
  6. CLIPTextEncode(negative).output[0] → ControlNetApplyAdvanced.input "negative" (slot 1)
  7. ControlNetApplyAdvanced.output[0] (positive) → KSampler.input "positive" (slot 1)
  8. ControlNetApplyAdvanced.output[1] (negative) → KSampler.input "negative" (slot 2)

  SIMPLIFIED CHAIN (non-union ControlNet, no pose preprocessing):
  1. CLIPTextEncode(positive).output[0] → ControlNetApplyAdvanced.input "positive" (slot 0)
  2. CLIPTextEncode(negative).output[0] → ControlNetApplyAdvanced.input "negative" (slot 1)
  3. ControlNetLoader.output[0] → ControlNetApplyAdvanced.input "control_net" (slot 2)
  4. LoadImage.output[0] → ControlNetApplyAdvanced.input "image" (slot 3)
  5. ControlNetApplyAdvanced.output[0] (positive) → KSampler.input "positive" (slot 1)
  6. ControlNetApplyAdvanced.output[1] (negative) → KSampler.input "negative" (slot 2)

  DWPreprocessor widgets_values: [true, true, true, 512, "yolox_l.onnx", "dw-ll_ucoco_384_bs5.torchscript.pt"]
    SetUnionControlNetType widgets_values: ["openpose"]  (or "canny", "depth", etc.)

  ControlNetApplyAdvanced SETTING GUIDANCE: reason about strength (0.8-1.0 typical), start_percent (0.0 typical), end_percent (adjust per use case — see SETTING GUIDANCE section below)
  NEVER send ControlNetLoader output directly to KSampler — it MUST go through ControlNetApplyAdvanced.
  NEVER send MODEL to CLIPLoader/VAELoader/ControlNetLoader — they only have widget inputs.

SETTING GUIDANCE (reason about these based on the user's request — do NOT blindly copy):
  KSampler:
    - control_after_generate: "randomize" is typical for exploration, "fixed" for reproducibility
    - steps: 20-30 range is common; lightning/turbo models use 4-8 steps
    - cfg: 7-8.5 for standard models; 1-2 for FLUX/lightning
    - sampler_name: "dpmpp_2m" is versatile; "euler" for speed; "dpmpp_sde" for quality
    - scheduler: "karras" for most workflows; "normal" for basic; "sgm_uniform" for FLUX
    - denoise: 1.0 for txt2img; 0.5-0.7 for img2img; 0.85-0.95 for strong regen
  ControlNetApplyAdvanced:
    - strength: 0.8-1.0 typical; lower for subtle guidance
    - start_percent: 0.0 typical (apply from start)
    - end_percent: how far through sampling to apply; 1.0 for full, 0.1-0.3 for early-only guidance
    - Reason about these based on the controlnet type and desired effect

EXAMPLE — A working 11-node GGUF txt2img workflow with LoRA:
  Node 1 UnetLoaderGGUFAdvanced → outputs MODEL (slot 0, links:[1])
  Node 11 LoraLoaderModelOnly → inputs: model (slot 0, link:1) → outputs MODEL (slot 0, links:[2])
  Node 2 CLIPLoader → outputs CLIP (slot 0, links:[3,4])
  Node 3 CLIPTextEncode (positive) → inputs: clip (slot 0, link:3) → outputs CONDITIONING (slot 0, links:[5])
  Node 4 CLIPTextEncode (negative) → inputs: clip (slot 0, link:4) → outputs CONDITIONING (slot 0, links:[6])
  Node 5 EmptyLatentImage → outputs LATENT (slot 0, links:[7])
  Node 6 KSampler → inputs: model (slot 0, link:2), positive (slot 1, link:5), negative (slot 2, link:6), latent_image (slot 3, link:7) → outputs LATENT (slot 0, links:[8])
  Node 7 VAELoader → outputs VAE (slot 0, links:[9])
  Node 8 VAEDecode → inputs: samples (slot 0, link:8), vae (slot 1, link:9) → outputs IMAGE (slot 0, links:[10,11])
  Node 9 PreviewImage → inputs: images (slot 0, link:10)
  Node 10 SaveImage → inputs: images (slot 0, link:11)

  Links: [1,1,0,11,0,"MODEL"], [2,11,0,6,0,"MODEL"], [3,2,0,3,0,"CLIP"], [4,2,0,4,0,"CLIP"],
         [5,3,0,6,1,"CONDITIONING"], [6,4,0,6,2,"CONDITIONING"], [7,5,0,6,3,"LATENT"],
         [8,6,0,8,0,"LATENT"], [9,7,0,8,1,"VAE"], [10,8,0,9,0,"IMAGE"], [11,8,0,10,0,"IMAGE"]

MANDATORY CONNECTION SELF-CHECK (do this before outputting your JSON):
  Walk EVERY link in your links array and verify:
  1. The source node's output slot at source_output_slot produces the TYPE in the link
  2. The target node's input slot at target_input_slot accepts that same TYPE
  3. No loader node (CLIPLoader, VAELoader, ControlNetLoader, UnetLoaderGGUFAdvanced) receives incoming links — they only have widget inputs
  4. Every KSampler has model, positive, negative, and latent_image connected
  5. Every VAEDecode has samples and vae connected
  6. Every CLIPTextEncode has clip connected
    7. If ControlNet nodes are present: ControlNetLoader → [SetUnionControlNetType if union model] → ControlNetApplyAdvanced → KSampler (never skip ControlNetApplyAdvanced)
    8. If DW pose preprocessing is present: LoadImage → DWPreprocessor → ControlNetApplyAdvanced.image (never send raw image when pose preprocessing is needed)
  If ANY connection violates these rules, FIX IT before outputting the JSON.
`;

const MODE_PROMPTS: Record<string, string> = {
    build: `${SYSTEM_PROMPT_BASE}

MODE: BUILD — The user wants you to CREATE a new ComfyUI workflow from scratch.

${COMFYUI_WORKFLOW_FORMAT}

INSTRUCTIONS:
- Output a COMPLETE, valid ComfyUI workflow JSON that can be loaded directly.
- Wrap the workflow JSON in a \`\`\`json code block.
- NEVER put comments (// or /* */) inside JSON — JSON does not support comments and they break parsing.
- Before the JSON, briefly explain what the workflow does (2-3 sentences max).
- Treat the CURRENT user message as the source of truth for requested features; do not carry forward old feature choices from prior chat history unless explicitly asked.
- Build the minimal workflow that satisfies the current request.
- Do NOT add ControlNet, pose, DWPreprocessor, SetUnionControlNetType, or reference-image guidance unless explicitly requested in the current message.
- Ensure all node IDs are unique, all links connect valid slots, and execution order is correct.
- Position nodes left-to-right with readable spacing (increment x by 400-500 per stage).
- The workflow MUST be self-contained and immediately usable.
- Use standard, well-known ComfyUI node class_type names. If the user needs a custom node they don't have, ComfyUI Manager can install it.
- Verify last_link_id matches the highest link_id used in the links array.
- Verify last_node_id matches the highest node id used.

COMFYUI-MODELS RULES:
- The CONTEXT section may list COMFYUI-MODELS by category (checkpoints, unet, diffusion_models, loras, vae, clip, text_encoders, etc.).
- These are the actual model files installed on the user's system. ONLY use exact filenames from these lists.
- When a model family is detected (e.g. QWEN), only models matching that family are shown — use ONLY those models.
- NEVER invent model filenames. If the list doesn't contain what you need, say so.
- The system has automatic model path resolution — close matches will be corrected automatically.
- GGUF and non-GGUF formats are FULLY COMPATIBLE and CAN be mixed freely in the same workflow.
  For example: a .gguf UNET/diffusion model with a .safetensors CLIP/text_encoder is perfectly valid.
  Use whatever format is available for each component.

CRITICAL — MODEL FAMILY COMPATIBILITY (violations will be rejected):
    This is a compatibility constraint, NOT a workflow template.
    Do not force a specific graph shape unless the user explicitly asks for it.
    All models in one workflow must stay family-compatible.
    Families: SD15, SDXL, FLUX, Qwen, Hunyuan, Z-Image, WAN.
    Rules:
    - When the user explicitly requests a family (e.g. SDXL, FLUX, Qwen), choose loaders/models that match that family.
    - Use any valid topology that satisfies the user request and keeps model families compatible.
    - SD 1.5 components must pair with SD 1.5 family models.
    - SDXL components must pair with SDXL family models.
    - FLUX components must pair with FLUX family models.
    - Qwen components must pair with Qwen family models.
    - SDXL checkpoints may supply CLIP+VAE; separate loaders are optional when compatible.
    - NEVER mix incompatible families (e.g. SDXL VAE with non-SDXL base model).
    - ⚠️ CRITICAL SIZE MATCHING: Diffusion/UNET and CLIP/text_encoder MUST be the SAME parameter size. A 7B diffusion model (hidden_dim=3584) REQUIRES a 7B text encoder. A 4B model (hidden_dim=2560) REQUIRES a 4B text encoder. Mixing 7B diffusion + 4B text encoder CRASHES immediately. Always check the [SIZE] tag on model names. When GGUF models lack a [SIZE] tag, they share the size of the non-GGUF model in the same family. Prefer 7B+7B pairings when available.`,

    modify: `${SYSTEM_PROMPT_BASE}

MODE: MODIFY — The user wants you to PATCH/MODIFY their current workflow.

${COMFYUI_WORKFLOW_FORMAT}

INSTRUCTIONS:
- The user's current workflow graph is provided in CONTEXT.
- Output a modified version of their COMPLETE workflow JSON with your changes applied.
- Wrap the workflow JSON in a \`\`\`json code block.
- Before the JSON, explain what you changed and why (2-3 sentences).
- Preserve the user's existing nodes, positions, and wiring unless they asked to change them.
- Only add, remove, or rewire what the user requested.
- Keep all existing node IDs stable — only use new IDs for newly added nodes.
- Use standard, well-known ComfyUI node class_type names.
- Verify last_link_id matches the highest link_id used in the links array.
- Verify last_node_id matches the highest node id used.

COMFYUI-MODELS RULES:
- The CONTEXT section may list COMFYUI-MODELS by category.
- If models are listed, use ONLY exact filenames from those lists (without the [SIZE] annotation).
- GGUF and non-GGUF formats can be mixed freely in the same workflow.
- ⚠️ Diffusion/UNET and CLIP/text_encoder MUST be the SAME parameter size ([7B]+[7B] or [4B]+[4B]). Mixing sizes (e.g. 7B+4B) CRASHES. Check [SIZE] tags on model names.
- NEVER invent model filenames.`,

    ask: `${SYSTEM_PROMPT_BASE}

MODE: ASK — The user has a general question about their workflow, ComfyUI, or image generation.

INSTRUCTIONS:
- Respond with clear, helpful natural language.
- If the user asks about their workflow, reference the graph context provided.
- Be concise — the user sees this in a small chat panel.
- If applicable, suggest specific node types, settings, or wiring changes.`,

    learn: `${SYSTEM_PROMPT_BASE}

MODE: LEARN — The user wants to learn about ComfyUI concepts, techniques, or best practices.

INSTRUCTIONS:
- Teach clearly with examples and explanations.
- Explain ComfyUI concepts (nodes, links, samplers, schedulers, LoRAs, etc.).
- Reference the user's current workflow if relevant for context.
- Be educational but concise.`,

    question: `${SYSTEM_PROMPT_BASE}

MODE: QUESTION — The user has a quick, specific question.

INSTRUCTIONS:
- Give a direct, brief answer.
- No lengthy explanations unless the question requires it.
- If it's a yes/no question, lead with yes or no then explain briefly.`,

    fix: `${SYSTEM_PROMPT_BASE}

MODE: FIX — The user wants you to diagnose and fix errors in their current workflow.

${COMFYUI_WORKFLOW_FORMAT}

INSTRUCTIONS:
- The user's current workflow graph AND execution errors are provided in CONTEXT.
- Analyze the errors to identify the root cause (missing connections, wrong node types, invalid settings, missing models, etc.).
- Output a FIXED version of their COMPLETE workflow JSON with corrections applied.
- Wrap the workflow JSON in a \`\`\`json code block.
- Before the JSON, explain what was broken and what you fixed (be specific about node IDs and error messages).
- Preserve the user's existing design intent — only change what's necessary to fix the errors.
- If errors are caused by missing custom nodes or models, explain that clearly instead of outputting a workflow.

DIAGNOSTIC APPROACH:
- Even if the error messages are vague (e.g. "Prompt outputs failed validation"), you MUST analyze the full workflow JSON yourself.
- Walk every node: check that widget_values match the node type's expectations, referenced model filenames exist in the COMFYUI-MODELS list, all required inputs are connected, and data types match.
- List EVERY issue you find, not just the first one. Number them.
- Also consider WHAT THE USER ASKED FOR — if they mention a specific model, LoRA, or setting, make sure the output workflow actually uses it.
- If a model filename in a widget_value doesn't appear in the COMFYUI-MODELS list, that is almost certainly the cause of a validation error. Replace it with the correct available model.
- Common validation failures: wrong checkpoint/LoRA filename, sampler name not valid for the model type, steps too high for lightning models, missing connections, type mismatches.

COMFYUI-MODELS RULES:
- The CONTEXT section may list COMFYUI-MODELS by category.
- If models are listed, use ONLY exact filenames from those lists (without the [SIZE] annotation).
- GGUF and non-GGUF formats can be mixed freely in the same workflow.
- ⚠️ Diffusion/UNET and CLIP/text_encoder MUST be the SAME parameter size ([7B]+[7B] or [4B]+[4B]). Mixing sizes (e.g. 7B+4B) CRASHES. Check [SIZE] tags on model names.
- NEVER invent model filenames.`,
};

async function enableAIBridge(): Promise<void> {
    if (aiBridgeActive) {
        vscode.window.showInformationMessage('AI Bridge is already active.');
        return;
    }

    // Ensure listener is running
    const host = getConfig<string>('host', '127.0.0.1');
    const port = getConfig<number>('port', 1337);
    const alive = await pingHealth(host, port);
    if (!alive) {
        vscode.window.showWarningMessage(
            'Faith Agent listener is not running. Start it first (click the status bar icon), then enable the AI Bridge.',
        );
        return;
    }

    // Select all Copilot language models
    const preferredFamily = getConfig<string>('modelFamily', 'gpt-4o-mini');
    log(`AI Bridge: Querying available models (preferred: ${preferredFamily})...`);
    let models: vscode.LanguageModelChat[];
    try {
        models = await vscode.lm.selectChatModels({ vendor: 'copilot' });
    } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        vscode.window.showErrorMessage(`AI Bridge: Failed to select model — ${msg}`);
        return;
    }

    if (!models || models.length === 0) {
        vscode.window.showErrorMessage(
            'AI Bridge: No Copilot language model available. Ensure GitHub Copilot is installed and active.',
        );
        return;
    }

    // ── Filter to ≤3x models and build cost info ──
    log(`AI Bridge: Available models (${models.length}):`);
    allSafeModels.clear();
    const modelListForFrontend: Array<{
        family: string;
        name: string;
        multiplier: number;
        label: string;
        maxTokens: number;
    }> = [];

    for (const m of models) {
        const cost = getModelCost(m.family);
        const allowed = cost.multiplier <= MAX_ALLOWED_MULTIPLIER;
        log(`  - "${m.name}" family=${m.family} cost=${cost.label} maxTokens=${m.maxInputTokens} ${allowed ? '✅' : '⛔ BLOCKED (>' + MAX_ALLOWED_MULTIPLIER + 'x)'}`);
        if (allowed) {
            allSafeModels.set(m.family, m);
            modelListForFrontend.push({
                family: m.family,
                name: m.name,
                multiplier: cost.multiplier,
                label: cost.label,
                maxTokens: m.maxInputTokens,
            });
        }
    }

    if (allSafeModels.size === 0) {
        log('AI Bridge: ALL models are over 3x cost. Refusing to start.');
        vscode.window.showErrorMessage(
            'AI Bridge: No models at ≤3x cost available. Ensure GPT-4o-mini or similar is available.',
        );
        return;
    }

    // Sort frontend list by multiplier (cheapest first)
    modelListForFrontend.sort((a, b) => a.multiplier - b.multiplier);

    // Pick default model — prefer 0x models first
    const cheapOrder = ['gpt-4o-mini', 'gpt-4o', 'gpt-4.1', 'gpt-5-mini', 'raptor-mini', 'oswe-vscode'];
    let picked = allSafeModels.get(preferredFamily);
    if (!picked) {
        for (const fam of cheapOrder) {
            picked = allSafeModels.get(fam);
            if (picked) { break; }
        }
    }
    if (!picked) {
        picked = allSafeModels.values().next().value!;
    }
    activeLlm = picked;
    log(`AI Bridge: Default model → "${activeLlm.name}" (family: ${activeLlm.family})`);

    // Test request — triggers consent dialog on first use
    try {
        log('AI Bridge: Sending test request (may show consent dialog)...');
        const testMessages = [
            vscode.LanguageModelChatMessage.User('Respond with exactly: "AI Bridge connected." Nothing else.'),
        ];
        const response = await activeLlm.sendRequest(testMessages, {});
        let text = '';
        for await (const part of response.stream) {
            if (part instanceof vscode.LanguageModelTextPart) {
                text += part.value;
            }
        }
        log(`AI Bridge: Test passed — model responded: "${text.trim().substring(0, 100)}"`);
    } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        log(`AI Bridge: Test request failed — ${msg}`);
        vscode.window.showErrorMessage(
            `AI Bridge: LLM consent or test failed — ${msg}. Try again.`,
        );
        activeLlm = null;
        return;
    }

    // Push model list to listener so the frontend can fetch it
    const defaultFamily = activeLlm.family;
    try {
        await httpPost(`http://${host}:${port}/agent/models`, {
            models: modelListForFrontend,
            default_family: defaultFamily,
        });
        log(`AI Bridge: Pushed ${modelListForFrontend.length} models to listener for frontend selector.`);
    } catch {
        log('AI Bridge: Warning — failed to push model list to listener.');
    }

    // Mark existing inbox items as processed
    try {
        const data = await httpGet(`http://${host}:${port}/inbox`);
        const parsed = JSON.parse(data);
        if (parsed.ok && Array.isArray(parsed.items)) {
            for (const item of parsed.items) {
                if (item.support_id) {
                    processedSupportIds.add(item.support_id);
                }
            }
            log(`AI Bridge: Marked ${processedSupportIds.size} existing inbox items as already processed.`);
        }
    } catch {
        // start fresh
    }

    // Start polling
    aiBridgeActive = true;
    aiBridgeInterval = setInterval(() => {
        pollInbox(host, port);
    }, 3000);

    statusItem.text = '$(zap) Faith: AI Bridge';
    statusItem.tooltip = 'AI Bridge active — auto-forwarding ComfyUI messages to Copilot';
    log('AI Bridge: ACTIVE — polling inbox every 3 seconds.');
    vscode.window.showInformationMessage(
        `AI Bridge activated! Using ${activeLlm.name} (${getModelCost(activeLlm.family).label}). User can change model in ComfyUI panel.`,
    );
}

function disableAIBridge(): void {
    if (aiBridgeInterval) {
        clearInterval(aiBridgeInterval);
        aiBridgeInterval = null;
    }
    if (aiBridgeActive) {
        aiBridgeActive = false;
        activeLlm = null;
        allSafeModels.clear();
        log('AI Bridge: Disabled.');
        vscode.window.showInformationMessage('AI Bridge disabled.');
        if (serverProcess) {
            setStatusOnline();
        } else {
            setStatusOffline();
        }
    }
}

async function pollInbox(host: string, port: number): Promise<void> {
    if (bridgeProcessing || !aiBridgeActive || !activeLlm) { return; }

    try {
        const raw = await httpGet(`http://${host}:${port}/inbox`);
        const parsed = JSON.parse(raw);
        if (!parsed.ok || !Array.isArray(parsed.items)) { return; }

        for (const item of parsed.items) {
            const sid = item.support_id;
            if (!sid || processedSupportIds.has(sid)) { continue; }

            processedSupportIds.add(sid);
            log(`AI Bridge: ═══════════════════════════════════════════════════════`);
            log(`AI Bridge: NEW REQUEST [${sid}]`);
            log(`AI Bridge: User message (${String(item.message || '').length} chars): "${item.message || ''}"`);
            log(`AI Bridge: Mode: ${item.mode || 'ask'} | Model: ${item.model_family || 'default'}`);
            log(`AI Bridge: ═══════════════════════════════════════════════════════`);

            // Process this message (don't await — let polling continue)
            bridgeProcessing = true;
            processInboxItem(item, host, port)
                .catch((err: unknown) => {
                    const msg = err instanceof Error ? err.message : String(err);
                    log(`AI Bridge: Error processing ${sid} — ${msg}`);
                })
                .finally(() => { bridgeProcessing = false; });

            // Only process one new message per poll cycle
            break;
        }
    } catch {
        // Listener offline or network error — silently ignore
    }
}

async function processInboxItem(
    item: Record<string, unknown>,
    host: string,
    port: number,
): Promise<void> {
    if (!activeLlm) { return; }

    // ── REQUEST BOUNDARY: start per-mode log buffer ──
    _requestLogBuffer = [];
    if (logFileStream && logDir) {
        try {
            log('AI Bridge: ──── NEW REQUEST BOUNDARY (logs preserved) ────');
        } catch { /* keep going */ }
    }
    log(`AI Bridge: ──── NEW SESSION (no truncation) ────`);

    const userMessage = String(item.message || 'No message provided.');
    const supportId = String(item.support_id || '');
    const mode = typeof item.mode === 'string' ? item.mode.toLowerCase() : 'ask';

    // ── Rule 7/8: Log ALL incoming inbox fields for full traceability ──
    const incomingKeys = Object.keys(item).sort().join(', ');
    log(`AI Bridge: Inbox item keys: [${incomingKeys}]`);
    log(`AI Bridge: Inbox raw selected_family="${String(item.selected_family ?? '(missing)')}" use_gguf=${String(item.use_gguf ?? '(missing)')}`);
    log(`AI Bridge: Inbox mode="${mode}" support_id="${supportId}" message_length=${userMessage.length}`);

    // ── Read user's explicit family + GGUF selections from the panel dropdown ──
    const selectedFamily = typeof item.selected_family === 'string' ? item.selected_family.trim() : '';
    const useGguf = Boolean(item.use_gguf);

    // ── Directive-First Architecture Block ──
    // When the panel sends intent + architecture, these are IMMUTABLE commands.
    // The agent builds the correct node skeleton BEFORE checking local files.
    const rawArch = item.architecture as Record<string, unknown> | undefined;
    const architecture = (rawArch && typeof rawArch === 'object') ? rawArch : null;
    const intent = typeof item.intent === 'string' ? item.intent.trim() : '';
    const archFamily = architecture ? String(architecture.family || '').trim() : '';
    const archEngine = architecture ? String(architecture.engine || '').trim().toUpperCase() : '';
    const archModality = architecture ? String(architecture.modality || '').trim().toUpperCase() : '';
    const isCompileMode = intent === 'COMPILE_WORKFLOW' && !!archFamily;

    // ── Blueprint state (hoisted so compiler directive can reference) ──
    // Populated during recipe injection (Step 4b), consumed by the compiler directive (Step 4e).
    let activeNodes: Record<string, string | null> = {};   // merged nodes (standard + gguf overrides)
    let activeWiring: string[] = [];                        // wiring array from registry
    let activeNotes = '';                                   // recipe notes
    let blueprintFamilyName = '';                           // display_name for the matched family

    if (isCompileMode) {
        log(`AI Bridge: ⚡ DIRECTIVE-FIRST COMPILE — family="${archFamily}" engine="${archEngine}" modality="${archModality}"`);
        log(`AI Bridge: Node selection will be HARD-LOCKED to architecture block. Local file availability will NOT prevent skeleton build.`);
    } else if (architecture) {
        log(`AI Bridge: Architecture block present but intent="${intent}" — not in compile mode`);
    }

    // Map specific registry keys (e.g. "FLUX1", "FLUX2_DEV") back to broad family
    // names used by the model filter. When the user selects from the dropdown,
    // we get a specific registry key and need its broad family for filtering.
    const registryKeyToBroadFamily: Record<string, string> = {
        'SD15':          'SD15',
        'SDXL':          'SDXL',
        'SD3':           'SD3',
        'FLUX1':         'FLUX1',
        'FLUX2_DEV':     'FLUX2',
        'FLUX2_KLEIN_4B':'FLUX2',
        'FLUX2_KLEIN_9B':'FLUX2',
        'QWEN':          'QWEN',
        'QWEN_2511_EDIT':'QWEN',
        'Z_IMAGE':       'Z-IMAGE',
        'OMNIGEN2':      'OMNIGEN2',
        'CHROMA':        'CHROMA',
        'HUNYUAN_IMAGE': 'HUNYUAN',
        'HUNYUAN_VIDEO': 'HUNYUAN',
        'HUNYUAN3D':     'HUNYUAN',
        'WAN_2_1':       'WAN',
        'WAN_2_2':       'WAN',
    };

    let requestedModelFamily: string | null = null;
    let explicitRegistryKey: string | null = null;  // set when user used the dropdown

    if (selectedFamily && registryKeyToBroadFamily[selectedFamily]) {
        // User explicitly selected a family from the dropdown — use it directly
        explicitRegistryKey = selectedFamily;
        requestedModelFamily = registryKeyToBroadFamily[selectedFamily];
        log(`AI Bridge: User selected family from dropdown: "${selectedFamily}" (broad: ${requestedModelFamily}, GGUF: ${useGguf})`);
    } else {
        // Fallback: infer family from the user's message text
        requestedModelFamily = inferRequestedModelFamily(userMessage);
        if (requestedModelFamily) {
            log(`AI Bridge: Requested model family inferred from user message: ${requestedModelFamily}`);
        }
    }

    // ── Fallback: infer family from the current graph during modify/fix ──
    // When the user says "make it a 4 step" the message has no family keyword,
    // but the existing workflow's model loaders reveal which family is in use.
    if (!requestedModelFamily && (mode === 'modify' || mode === 'fix')) {
        const graphForInference = item.graph as Record<string, unknown> | undefined;
        if (graphForInference) {
            requestedModelFamily = inferFamilyFromGraph(graphForInference);
            if (requestedModelFamily) {
                log(`AI Bridge: Family inferred from current graph: ${requestedModelFamily}`);
            }
        }
    }

    // ── Per-request model selection from user's dropdown ──
    const DEFAULT_FAMILY = 'gpt-4o-mini';
    let modelToUse = allSafeModels.get(DEFAULT_FAMILY) || activeLlm;
    const requestedFamily = typeof item.model_family === 'string' ? item.model_family : '';
    if (requestedFamily && allSafeModels.has(requestedFamily)) {
        const cost = getModelCost(requestedFamily);
        if (cost.multiplier <= MAX_ALLOWED_MULTIPLIER) {
            modelToUse = allSafeModels.get(requestedFamily)!;
            log(`AI Bridge: Using user-selected model "${modelToUse.name}" (${cost.label}) for [${supportId}]`);
        } else {
            log(`AI Bridge: ⛔ User requested "${requestedFamily}" but it's ${cost.label} — BLOCKED. Using default.`);
        }
    } else if (requestedFamily) {
        log(`AI Bridge: User requested "${requestedFamily}" but it's not available. Using default.`);
    }

    // Build context from the support bundle
    const contextParts: string[] = [];

    // Graph context
    const graph = item.graph as Record<string, unknown> | undefined;
    if (graph && typeof graph === 'object') {
        const nodes = Array.isArray(graph.nodes) ? graph.nodes : [];
        contextParts.push(`Graph: ${nodes.length} nodes loaded.`);

        // For modify/fix mode, include the full graph JSON so LLM can patch it
        if ((mode === 'modify' || mode === 'fix') && nodes.length > 0 && nodes.length <= 80) {
            try {
                contextParts.push(`Current workflow JSON:\n\`\`\`json\n${JSON.stringify(graph, null, 2).substring(0, 12000)}\n\`\`\``);
            } catch {
                const typeList = nodes
                    .map((n: Record<string, unknown>) => `${n.id}: ${n.type || 'unknown'}`)
                    .join(', ');
                contextParts.push(`Node list: [${typeList}]`);
            }
        } else if (nodes.length > 0 && nodes.length <= 100) {
            const typeList = nodes
                .map((n: Record<string, unknown>) => `${n.id}: ${n.type || 'unknown'}`)
                .join(', ');
            contextParts.push(`Node list: [${typeList}]`);
        } else if (nodes.length > 100) {
            contextParts.push(`(${nodes.length} nodes — too many to list individually)`);
        }
    } else {
        contextParts.push('Graph: No graph data provided.');
    }

    // Available resources (for Build/Modify/Fix modes)
    const resources = item.available_resources as Record<string, unknown> | undefined;
    let availableModels: Record<string, string[]> | undefined;
    if (resources && typeof resources === 'object' && (mode === 'build' || mode === 'modify' || mode === 'fix')) {
        const models = resources.models as Record<string, string[]> | undefined;
        if (models && typeof models === 'object') {
            availableModels = models;

            // ── Family-based filtering ──
            // If we detected a diffusion model family from the user's message
            // (e.g. QWEN, FLUX, SDXL), only send models matching that family.
            // This prevents the LLM from mixing incompatible model sizes/families.
            const diffusionFamily = requestedModelFamily; // already inferred above

            // ── Pre-detect FLUX sub-family for model filtering ──
            // Must happen BEFORE filtering so we show only the correct FLUX variant's models.
            // When the dropdown was used, use the explicit key directly.
            let fluxSubFamilyHint: string | null = null;
            if (diffusionFamily === 'FLUX') {
                if (explicitRegistryKey?.startsWith('FLUX')) {
                    // Dropdown selected a specific FLUX variant
                    fluxSubFamilyHint = explicitRegistryKey;
                } else if (/klein.*4b/i.test(userMessage)) {
                    fluxSubFamilyHint = 'FLUX2_KLEIN_4B';
                } else if (/klein.*9b/i.test(userMessage)) {
                    fluxSubFamilyHint = 'FLUX2_KLEIN_9B';
                } else if (/flux[_\-\s]?2/i.test(userMessage)) {
                    fluxSubFamilyHint = 'FLUX2_DEV';
                } else {
                    fluxSubFamilyHint = 'FLUX1';
                }
                log(`AI Bridge: FLUX sub-family hint for model filtering: ${fluxSubFamilyHint}`);
            }

            // Exclusion patterns: models that match a MORE SPECIFIC sub-family
            // should be excluded from the broader parent family.
            // e.g. "qwen-4b-zimage-heretic-q8.gguf" is Z-IMAGE, not QWEN.
            const familyExclusions: Record<string, RegExp> = {
                'QWEN': /z[_\- ]?image|zimage|heretic/i,  // Z-Image models use qwen arch but are a separate family
            };
            const familyPatterns: Record<string, RegExp> = {
                'QWEN':     /qwen/i,
                // FLUX filtering is sub-family-aware: FLUX1 regex excludes FLUX2 files and vice versa.
                // File paths include folder prefixes (e.g. "FLUX\file" vs "FLUX2\file").
                'FLUX': fluxSubFamilyHint === 'FLUX1' ? /flux(?![_\-\s]?2)/i
                      : fluxSubFamilyHint?.startsWith('FLUX2') ? /flux[_\-\s]?2/i
                      : /flux/i,
                'SDXL':     /sdxl|sd[_\- ]?xl|stabilityai/i,
                'SD15':     /sd[_\- ]?1\.?5|v1[_\- ]?5|stable[_\- ]?diffusion[_\- ]?1/i,
                'SD3':      /sd3|sd[_\- ]?3\.?5/i,
                'HUNYUAN':  /hunyuan/i,
                'Z-IMAGE':  /z[_\- ]?image|zimage|heretic/i,
                'WAN':      /wan/i,
                'CHROMA':   /chroma/i,
                'OMNIGEN2': /omnigen/i,
            };
            const familyRegex = diffusionFamily ? familyPatterns[diffusionFamily] : null;
            const familyExclude = diffusionFamily ? (familyExclusions[diffusionFamily] || null) : null;

            const resourceLines: string[] = [];
            if (diffusionFamily) {
                resourceLines.push(`COMFYUI-MODELS (filtered to ${diffusionFamily} family):`);
                log(`AI Bridge: Filtering COMFYUI-MODELS to family "${diffusionFamily}"`);
            } else {
                resourceLines.push('COMFYUI-MODELS ON THIS SYSTEM:');
            }

            // Annotate model filenames with [SIZE] tag when detectable from the name
            const inferModelSize = (filename: string): string => {
                // Match patterns like _7b, -7B, _4b, -4B, qwen3-4b, etc.
                const m = filename.match(/[\-_](\d{1,3})[bB](?:[\-_\.]|$)/);
                return m ? ` [${m[1]}B]` : '';
            };

            let totalShown = 0;
            for (const [folder, files] of Object.entries(models)) {
                if (!Array.isArray(files) || files.length === 0) { continue; }

                // Filter by family if detected, with exclusion for sub-families
                const filtered = familyRegex
                    ? files.filter(f => familyRegex.test(f) && (!familyExclude || !familyExclude.test(f)))
                    : files;

                if (filtered.length === 0) { continue; }

                // Cap at 50 per category (family filter means fewer items)
                const cap = familyRegex ? 50 : 30;
                const listed = filtered.slice(0, cap);
                // Annotate each model with [SIZE] if detectable
                const annotated = listed.map(f => `${f}${inferModelSize(f)}`);
                resourceLines.push(`  ${folder}: ${annotated.join(', ')}${filtered.length > cap ? ` ... and ${filtered.length - cap} more` : ''}`);
                totalShown += listed.length;
            }

            if (totalShown > 0) {
                resourceLines.push('');
                resourceLines.push('NOTE: GGUF (.gguf) and non-GGUF (.safetensors/.bin) formats are fully compatible and CAN be mixed in the same workflow.');
                resourceLines.push('');
                resourceLines.push('⚠️ SIZE COMPATIBILITY (CRITICAL):');
                resourceLines.push('- Models annotated [7B] have hidden_dim=3584. Models annotated [4B] have hidden_dim=2560.');
                resourceLines.push('- The diffusion/unet model and the text_encoder/clip model MUST be the SAME size (both 7B or both 4B).');
                resourceLines.push('- Mismatching sizes (e.g. 7B diffusion + 4B text encoder) causes an immediate runtime crash.');
                resourceLines.push('- GGUF quantized diffusion models (Q2_K, Q3_K_S, etc.) without a [SIZE] tag are the SAME architecture size as the non-GGUF version in the same family.');
                resourceLines.push('- When unsure, pick ALL models of the SAME size tag. Prefer 7B+7B pairings when both are available.');
                resourceLines.push('');
                if (diffusionFamily) {
                    resourceLines.push(`Only ${diffusionFamily}-family models are shown. Use ONLY these exact filenames (without the [SIZE] annotation).`);
                }
                contextParts.push(resourceLines.join('\n'));
                log(`AI Bridge: Sent ${totalShown} COMFYUI-MODELS to LLM${diffusionFamily ? ` (family: ${diffusionFamily})` : ''}`);
            } else {
                if (isCompileMode) {
                    // Directive-First: no local models found but we're in compile mode — proceed anyway.
                    // The LLM will build the correct skeleton using ideal filenames.
                    // Faith Gate (validateModelAvailability) will catch missing files at the end.
                    contextParts.push(`COMFYUI-MODELS: No ${diffusionFamily || ''} models found locally. Build the workflow using the FAMILY RECIPE below with ideal/placeholder model filenames. The post-build validation will handle file resolution.`);
                    log(`AI Bridge: ⚡ COMPILE MODE — no local models for "${diffusionFamily || 'any'}" but proceeding (directive-first)`);
                } else {
                    contextParts.push('COMFYUI-MODELS: No matching models found for this family on the system.');
                    log(`AI Bridge: No COMFYUI-MODELS matched family "${diffusionFamily || 'any'}"`);
                }
            }

            // ── GGUF availability gate (OUTSIDE totalShown block) ──
            // When user requests GGUF, check if .gguf diffusion files exist.
            // In COMPILE mode: advisory only (log, don't block — build the skeleton anyway).
            // In legacy mode: abort with clear error.
            if (useGguf && diffusionFamily) {
                const ggufCategories = ['unet', 'unet_gguf', 'diffusion_models', 'checkpoints'];
                let ggufFileCount = 0;
                const allGgufFiles: string[] = [];
                for (const cat of ggufCategories) {
                    const catFiles = (models as Record<string, string[]>)[cat];
                    if (Array.isArray(catFiles)) {
                        const filteredGguf = familyRegex
                            ? catFiles.filter(f => familyRegex.test(f) && (!familyExclude || !familyExclude.test(f)))
                            : catFiles;
                        const ggufFiles = filteredGguf.filter(f => f.toLowerCase().endsWith('.gguf'));
                        ggufFileCount += ggufFiles.length;
                        allGgufFiles.push(...ggufFiles);
                    }
                }
                log(`AI Bridge: GGUF gate check — found ${ggufFileCount} .gguf files for ${diffusionFamily}: [${allGgufFiles.join(', ')}]`);
                if (ggufFileCount === 0) {
                    if (isCompileMode) {
                        // Directive-First: build the skeleton with GGUF nodes anyway.
                        // Faith Gate will block at the end with download links.
                        log(`AI Bridge: ⚠ GGUF GATE ADVISORY — no .gguf files for ${diffusionFamily}, but COMPILE mode — building skeleton anyway`);
                    } else {
                        log(`AI Bridge: ⛔ GGUF GATE BLOCKED — user requested GGUF for ${diffusionFamily} but NO .gguf model files found on disk`);
                        const noGgufMsg = `⛔ Cannot build a ${selectedFamily || diffusionFamily} GGUF workflow — no .gguf model files found for this family on your system.\n\n` +
                            `You selected the GGUF checkbox but you don't have any .gguf diffusion model files installed for ${selectedFamily || diffusionFamily}.\n\n` +
                            `**What you can do:**\n` +
                            `1. Download a GGUF model for ${selectedFamily || diffusionFamily} (e.g. from huggingface.co/city96 or similar)\n` +
                            `2. Place it in your ComfyUI \\models\\unet\\ or \\models\\diffusion_models\\ folder\n` +
                            `3. Restart ComfyUI and try again\n\n` +
                            `Or uncheck the GGUF box to use the standard .safetensors models you already have.`;
                        try {
                            await httpPost(`http://${host}:${port}/agent/respond`, {
                                response_type: 'WAITING',
                                text_response: noGgufMsg,
                                support_id: supportId,
                            });
                        } catch { /* best effort */ }
                        bridgeProcessing = false;
                        return;
                    }
                }
            }
        }

        // NOTE: Node types are NOT sent — the LLM knows ComfyUI nodes from training data.
        // If it uses a node the user doesn't have, ComfyUI Manager can install it.
        // This saves thousands of tokens and prevents token-limit errors.
    }

    // ── Structured Family Recipe (from model_family_registry) ──
    // The ComfyUI panel (phase3_support.py) classifies installed models against
    // the model_family_registry.json and sends family_data in the relay payload.
    // The extension reads it here and injects a structured recipe block so the
    // LLM knows exactly which nodes and models to use — preventing cross-family mixing.
    const familyData = item.family_data as Record<string, Record<string, unknown>> | undefined;
    if (!familyData || typeof familyData !== 'object' || Object.keys(familyData).length === 0) {
        if (mode === 'build' || mode === 'modify' || mode === 'fix') {
            log('AI Bridge: ⚠ family_data missing from relay payload — ComfyUI panel did not send it. Family recipe will NOT be injected.');
        }
    }
    if (familyData && typeof familyData === 'object' && Object.keys(familyData).length > 0 && (mode === 'build' || mode === 'modify' || mode === 'fix')) {
        const detectedFamily = requestedModelFamily; // e.g. "QWEN", "FLUX", etc.

        // Map the inferred family name to a registry key
        const familyKeyMap: Record<string, string[]> = {
            'QWEN':     ['QWEN'],
            'FLUX':     ['FLUX1', 'FLUX2_DEV', 'FLUX2_KLEIN_4B', 'FLUX2_KLEIN_9B'],
            'FLUX1':    ['FLUX1'],
            'FLUX2':    ['FLUX2_DEV', 'FLUX2_KLEIN_4B', 'FLUX2_KLEIN_9B'],
            'SDXL':     ['SDXL'],
            'SD15':     ['SD15'],
            'SD3':      ['SD3'],
            'HUNYUAN':  ['HUNYUAN_VIDEO', 'HUNYUAN3D', 'HUNYUAN_IMAGE'],
            'Z-IMAGE':  ['Z_IMAGE'],
            'WAN':      ['WAN'],
            'CHROMA':   ['CHROMA'],
            'OMNIGEN2': ['OMNIGEN2'],
        };

        const candidateKeys = detectedFamily ? (familyKeyMap[detectedFamily] || []) : [];

        // ── Sub-family detection ──
        // When the user selected a specific family from the dropdown, use it directly
        // (skip all message-based detection). Otherwise, fall back to smart detection.
        let detectedSubFamily: string | null = null;

        if (explicitRegistryKey && familyData[explicitRegistryKey]) {
            // Dropdown selection → direct registry key, skip all inference
            detectedSubFamily = explicitRegistryKey;
            log(`AI Bridge: Using dropdown-selected family "${explicitRegistryKey}" as registry key (skipping sub-family detection)`);
        } else if (candidateKeys.length > 1 && detectedFamily === 'FLUX') {
            // User message determines FLUX sub-family.  User MUST explicitly say
            // "flux2", "flux 2", or "klein" to get a FLUX2 recipe.
            // Bare "flux" (or "flux1", "schnell") always → FLUX1.
            // Disk-based detection was REMOVED because it caused "flux" to silently
            // pick FLUX2_DEV when GGUF files existed, leading to wrong CLIP models.
            if (/klein.*4b/i.test(userMessage)) {
                detectedSubFamily = 'FLUX2_KLEIN_4B';
            } else if (/klein.*9b/i.test(userMessage)) {
                detectedSubFamily = 'FLUX2_KLEIN_9B';
            } else if (/flux[_\-\s]?2/i.test(userMessage)) {
                detectedSubFamily = 'FLUX2_DEV';
            } else {
                // Bare "flux", "flux1", "schnell", or anything without a "2" → FLUX1
                detectedSubFamily = 'FLUX1';
                if (!/flux[_\-\s]?1\b|schnell/i.test(userMessage)) {
                    log('AI Bridge: Bare "flux" detected without version qualifier, defaulting to FLUX1 (say "flux2" for FLUX.2)');
                }
            }

            if (detectedSubFamily) {
                log(`AI Bridge: FLUX sub-family "${detectedSubFamily}" detected, using its recipe`);
            }
        }

        // ── HUNYUAN sub-family detection (Video / Image / 3D) ──
        if (candidateKeys.length > 1 && detectedFamily === 'HUNYUAN') {
            if (/hunyuan[_\-\s]?image|hunyuanimage/i.test(userMessage)) {
                detectedSubFamily = 'HUNYUAN_IMAGE';
            } else if (/hunyuan[_\-\s]?video/i.test(userMessage)) {
                detectedSubFamily = 'HUNYUAN_VIDEO';
            } else if (/hunyuan[_\-\s]?3d/i.test(userMessage)) {
                detectedSubFamily = 'HUNYUAN3D';
            }

            // Fallback: detect from available model filenames on disk
            if (!detectedSubFamily && availableModels) {
                const allModelNames = Object.values(availableModels).flat();
                const hasImage = allModelNames.some(f => /hunyuanimage|hunyuan_image/i.test(f));
                const hasVideo = allModelNames.some(f => /hunyuan_video/i.test(f));
                const has3D    = allModelNames.some(f => /hunyuan3d|hunyuan_3d/i.test(f));
                if (hasImage)     { detectedSubFamily = 'HUNYUAN_IMAGE'; }
                else if (hasVideo){ detectedSubFamily = 'HUNYUAN_VIDEO'; }
                else if (has3D)   { detectedSubFamily = 'HUNYUAN3D'; }
            }

            if (detectedSubFamily) {
                log(`AI Bridge: HUNYUAN sub-family "${detectedSubFamily}" detected, using its recipe`);
            }
        }

        // Select the best matching family key
        let bestKey = '';
        if (detectedSubFamily && familyData[detectedSubFamily] && (candidateKeys.includes(detectedSubFamily) || explicitRegistryKey === detectedSubFamily)) {
            // Detected sub-family takes priority — even if "blocked" (missing models).
            // When the user explicitly selected from the dropdown (explicitRegistryKey),
            // bypass the candidateKeys check — the dropdown already validated the key.
            bestKey = detectedSubFamily;
        } else {
            // Default logic: first ready, then first blocked
            for (const k of candidateKeys) {
                const fd = familyData[k] as Record<string, unknown> | undefined;
                if (fd && fd.status === 'ready') { bestKey = k; break; }
            }
            if (!bestKey) {
                for (const k of candidateKeys) {
                    const fd = familyData[k] as Record<string, unknown> | undefined;
                    if (fd && fd.status === 'blocked') { bestKey = k; break; }
                }
            }
            if (!bestKey && candidateKeys.length > 0) {
                bestKey = candidateKeys[0];
            }
        }

        if (bestKey && familyData[bestKey]) {
            const fd = familyData[bestKey] as Record<string, unknown>;
            const recipe = fd.recipe as Record<string, unknown> | undefined;
            const installed = fd.installed as Record<string, string[]> | undefined;

            if (recipe) {
                const recipeLines: string[] = [];
                recipeLines.push(`\nFAMILY RECIPE (${fd.display_name || bestKey}):`);
                recipeLines.push(`Status: ${fd.status}`);
                recipeLines.push(`Output type: ${fd.output_type || 'image'}`);
                recipeLines.push(`Resolution: ${fd.native_resolution || 'flexible'}`);
                recipeLines.push(`Negative prompt: ${fd.supports_negative_prompt ? 'YES' : 'NO'}`);

                const strategy = String(recipe.strategy || '');
                const clipType = recipe.clip_type ? String(recipe.clip_type) : 'N/A';
                recipeLines.push(`Strategy: ${strategy}`);
                recipeLines.push(`CLIP type: ${clipType}`);

                // Emit default sampler configuration
                const defaultSampler = recipe.default_sampler as Record<string, unknown> | undefined;
                if (defaultSampler) {
                    const parts: string[] = [];
                    for (const [k, v] of Object.entries(defaultSampler)) {
                        parts.push(`${k}=${v}`);
                    }
                    recipeLines.push(`Default sampler config: ${parts.join(', ')}`);
                }

                // ── Blueprint-First: merge nodes + gguf_nodes into activeNodes ──
                // This is the core of the Directive-First architecture. When GGUF is requested,
                // gguf_nodes overwrite the matching standard node roles IMMEDIATELY.
                // The LLM sees ONE unified "MANDATORY NODES" block — no ambiguity.
                const nodes = recipe.nodes as Record<string, string | null> | undefined;
                const ggufNodes = recipe.gguf_nodes as Record<string, string> | undefined;

                if (nodes) {
                    // Start with standard nodes
                    activeNodes = { ...nodes };

                    // If GGUF requested AND the recipe has gguf_nodes, overlay them
                    if (useGguf && ggufNodes) {
                        activeNodes = { ...activeNodes, ...ggufNodes };
                        log(`AI Bridge: Blueprint merge — overlaid ${Object.keys(ggufNodes).length} GGUF substitutions: ${Object.entries(ggufNodes).map(([k, v]) => `${k}→${v}`).join(', ')}`);
                    }

                    // Store wiring + notes for the compiler directive
                    activeWiring = Array.isArray(recipe.wiring) ? recipe.wiring as string[] : [];
                    activeNotes = recipe.notes ? String(recipe.notes) : '';
                    blueprintFamilyName = String(fd.display_name || bestKey);

                    // Emit the MANDATORY BLUEPRINT block
                    recipeLines.push(`### MANDATORY WORKFLOW BLUEPRINT for ${fd.display_name || bestKey}${useGguf ? ' (GGUF)' : ''} ###`);
                    recipeLines.push('You MUST use these specific node types:');
                    for (const [role, nodeName] of Object.entries(activeNodes)) {
                        if (nodeName) {
                            recipeLines.push(`  - ${role}: ${nodeName}`);
                        }
                    }
                    if (useGguf) {
                        recipeLines.push('');
                        recipeLines.push('⚡ ENGINE: GGUF — The loader nodes above are ALREADY the GGUF variants.');
                        recipeLines.push('  Pick .gguf model files for diffusion/unet loaders. CLIP loaders accept .safetensors.');
                    }
                    recipeLines.push('');
                    recipeLines.push('DO NOT suggest alternative nodes. DO NOT substitute any node type listed above.');
                    recipeLines.push(`If the registry says ${activeNodes.text_encode_positive || activeNodes.text_encode || 'CLIPTextEncode'} is required for positive prompt, do NOT use a different text encoder.`);

                    // ── CLIPTextEncodeFlux widget hint ──
                    // The LLM often gets this wrong: CLIPTextEncodeFlux has 3 widgets [clip_l, t5xxl, guidance]
                    // and BOTH text fields must contain the same prompt text.
                    const posEncoder = activeNodes.text_encode_positive || activeNodes.text_encode;
                    if (posEncoder === 'CLIPTextEncodeFlux') {
                        recipeLines.push('');
                        recipeLines.push('⚠ CLIPTextEncodeFlux WIDGET FORMAT (CRITICAL):');
                        recipeLines.push('  This node has exactly 3 widgets_values: [clip_l, t5xxl, guidance]');
                        recipeLines.push('  POSITIVE encoder: widgets_values = ["<user prompt>", "<user prompt>", 3.5]');
                        recipeLines.push('    → You MUST duplicate the prompt into BOTH clip_l AND t5xxl fields!');
                        recipeLines.push('  NEGATIVE/EMPTY encoder: widgets_values = ["", "", 3.5]');
                        recipeLines.push('    → Both text fields MUST be empty strings. This node exists only to satisfy KSampler.negative input.');
                        recipeLines.push('  DO NOT leave t5xxl empty on the positive encoder — that breaks generation quality.');
                    }

                    // ── DualCLIPLoader widget hint ──
                    // The LLM often puts the same file in both slots or swaps them.
                    // Use the recipe's text_encoder_slots to tell it exactly which file goes where.
                    const clipLoader = activeNodes.clip_loader;
                    const teSlots = recipe.text_encoder_slots as Record<string, string> | undefined;
                    if ((clipLoader === 'DualCLIPLoader' || clipLoader === 'DualCLIPLoaderGGUF') && teSlots) {
                        const slot1File = teSlots.clip_name1 || 'clip_l.safetensors';
                        const slot2File = teSlots.clip_name2 || 't5xxl_fp16.safetensors';
                        // Resolve slot files against installed models to get full paths
                        const installedClipL = installed?.text_encoder_clip_l;
                        const installedT5 = installed?.text_encoder_t5xxl;
                        const resolvedSlot1 = (installedClipL && installedClipL.length > 0) ? installedClipL[0] : slot1File;
                        const resolvedSlot2 = (installedT5 && installedT5.length > 0) ? installedT5[0] : slot2File;

                        recipeLines.push('');
                        recipeLines.push(`⚠ ${clipLoader} WIDGET FORMAT (CRITICAL):`);
                        recipeLines.push(`  This node has exactly 3 widgets_values: [clip_name1, clip_name2, type]`);
                        recipeLines.push(`  Slot 1 (clip_name1) = clip_l encoder: "${resolvedSlot1}"`);
                        recipeLines.push(`  Slot 2 (clip_name2) = t5xxl encoder: "${resolvedSlot2}"`);
                        recipeLines.push(`  Slot 3 (type)       = "${String(recipe.clip_loader_type_value || clipType)}"`);
                        recipeLines.push(`  EXACT widgets_values: ["${resolvedSlot1}", "${resolvedSlot2}", "${String(recipe.clip_loader_type_value || clipType)}"]`);
                        recipeLines.push('  These are TWO DIFFERENT model files. Do NOT put the same file in both slots.');
                        recipeLines.push('  clip_l is a small CLIP-L text encoder (~250MB). t5xxl is a large T5-XXL encoder (~9GB).');
                    }

                    // ── KSamplerAdvanced widget hint ──
                    // KSamplerAdvanced has 9 widgets in a DIFFERENT order than KSampler (7 widgets).
                    // The LLM consistently confuses the two, producing shifted/NaN values.
                    const samplerNode = activeNodes.sampler;
                    if (samplerNode === 'KSamplerAdvanced') {
                        const ds = recipe.default_sampler as Record<string, unknown> | undefined;
                        const dsSteps = ds?.steps ?? 25;
                        const dsCfg = ds?.cfg ?? 8.0;
                        const dsSampler = ds?.sampler_name ?? 'euler';
                        const dsScheduler = ds?.scheduler ?? 'normal';
                        recipeLines.push('');
                        recipeLines.push('⚠ KSamplerAdvanced WIDGET FORMAT (CRITICAL):');
                        recipeLines.push('  This node has exactly 10 widgets_values in THIS order:');
                        recipeLines.push('    [add_noise, noise_seed, control_after_generate, steps, cfg, sampler_name, scheduler, start_at_step, end_at_step, return_with_leftover_noise]');
                        recipeLines.push('  Types: ["enable"|"disable", INT, "fixed"|"increment"|"decrement"|"randomize", INT, FLOAT, STRING, STRING, INT, INT, "enable"|"disable"]');
                        recipeLines.push(`  BASE PASS example:   ["enable", 123456789, "fixed", ${dsSteps}, ${dsCfg}, "${dsSampler}", "${dsScheduler}", 0, 20, "enable"]`);
                        recipeLines.push(`  REFINER PASS example: ["disable", 123456789, "fixed", ${dsSteps}, ${dsCfg}, "${dsSampler}", "${dsScheduler}", 20, ${dsSteps}, "disable"]`);
                        recipeLines.push('  ⚠ DO NOT USE KSampler format (7 widgets). KSamplerAdvanced has 10 widgets.');
                        recipeLines.push('  ⚠ noise_seed MUST be a valid integer (e.g. 123456789), NEVER NaN or null.');
                        recipeLines.push('  ⚠ cfg MUST be a valid float (e.g. 8.0), NEVER NaN or null.');
                        recipeLines.push('  ⚠ ALL numeric widget values in EVERY node MUST be valid numbers. NaN is NEVER acceptable.');
                    }

                    // ── KSampler widget hint (for non-Advanced families) ──
                    if (samplerNode === 'KSampler') {
                        const ds = recipe.default_sampler as Record<string, unknown> | undefined;
                        const dsSteps = ds?.steps ?? 20;
                        const dsCfg = ds?.cfg ?? 1.0;
                        const dsSampler = ds?.sampler_name ?? 'euler';
                        const dsScheduler = ds?.scheduler ?? 'simple';
                        const dsDenoise = ds?.denoise ?? 1.0;
                        recipeLines.push('');
                        recipeLines.push('⚠ KSampler WIDGET FORMAT (CRITICAL):');
                        recipeLines.push('  This node has exactly 7 widgets_values in THIS order:');
                        recipeLines.push('    [seed, control_after_generate, steps, cfg, sampler_name, scheduler, denoise]');
                        recipeLines.push('  Types: [INT, "fixed"|"increment"|"decrement"|"randomize", INT, FLOAT, STRING, STRING, FLOAT]');
                        recipeLines.push(`  Example: [123456789, "fixed", ${dsSteps}, ${dsCfg}, "${dsSampler}", "${dsScheduler}", ${dsDenoise}]`);
                        recipeLines.push('  ⚠ seed MUST be a valid integer (e.g. 123456789), NEVER NaN or null.');
                        recipeLines.push('  ⚠ cfg MUST be a valid float, NEVER NaN or null.');
                        recipeLines.push('  ⚠ ALL numeric widget values in EVERY node MUST be valid numbers. NaN is NEVER acceptable.');
                    }
                }

                if (recipe.notes) {
                    recipeLines.push(`Notes: ${recipe.notes}`);
                }

                // ── Wiring Graph ──
                // If the recipe has an explicit wiring array, emit it so the LLM
                // knows exactly how to connect nodes (critical for SamplerCustomAdvanced families).
                const wiring = recipe.wiring as string[] | undefined;
                if (Array.isArray(wiring) && wiring.length > 0) {
                    recipeLines.push('');
                    recipeLines.push('NODE WIRING (connect nodes EXACTLY as shown):');
                    for (const line of wiring) {
                        recipeLines.push(`  ${line}`);
                    }
                    recipeLines.push('CRITICAL: Follow this wiring chain exactly. Each arrow (→) is a connection between an output and an input. Do NOT skip nodes or invent alternative connections.');
                }

                // List installed files per component so the LLM uses exact filenames
                if (installed && Object.keys(installed).length > 0) {
                    recipeLines.push('Installed model files for this family:');
                    for (const [comp, files] of Object.entries(installed)) {
                        if (Array.isArray(files) && files.length > 0) {
                            const label = comp === 'lora' ? `${comp} (optional)` : comp;
                            recipeLines.push(`  ${label}: ${files.slice(0, 8).join(', ')}`);
                        }
                    }
                }

                // ── LoRA Step-Map Guidance ──
                // Some families have step-specific Lightning LoRAs.
                // Inject explicit instructions so the LLM swaps LoRAs when
                // the user changes step count (e.g. "make it a 4 step").
                const loraStepMap = recipe.lora_step_map as Record<string, unknown> | undefined;
                if (loraStepMap && installed) {
                    const loraFiles = (installed as Record<string, string[]>).lora;
                    if (Array.isArray(loraFiles) && loraFiles.length > 0) {
                        recipeLines.push('');
                        recipeLines.push('⚡ LIGHTNING LoRA STEP MAP (CRITICAL for modify/fix):');
                        const mapNote = loraStepMap.note ? String(loraStepMap.note) : '';
                        if (mapNote) { recipeLines.push(`  ${mapNote}`); }
                        const loraNode = loraStepMap.lora_node ? String(loraStepMap.lora_node) : 'LoraLoaderModelOnly';
                        recipeLines.push(`  LoRA loader node: ${loraNode}`);

                        // List each step count → available installed LoRA files
                        for (const [steps, prefixes] of Object.entries(loraStepMap)) {
                            if (steps === 'note' || steps === 'default_min_steps' || steps === 'lora_node') { continue; }
                            if (!Array.isArray(prefixes)) { continue; }
                            // Find installed files matching these prefixes
                            const matchingFiles = loraFiles.filter(f => {
                                const basename = f.replace(/^.*[\\/]/, '').replace(/\.[^.]+$/, '');
                                return (prefixes as string[]).some(prefix => basename.startsWith(prefix));
                            });
                            if (matchingFiles.length > 0) {
                                recipeLines.push(`  ${steps}-step LoRAs: ${matchingFiles.join(', ')}`);
                            }
                        }

                        const defaultMin = loraStepMap.default_min_steps;
                        if (defaultMin) {
                            recipeLines.push(`  ${defaultMin}+ steps: No lightning LoRA needed (remove the ${loraNode} node or bypass it).`);
                        }

                        recipeLines.push(`  RULE: When user changes step count, you MUST swap the LoRA file to match. Do NOT just change the KSampler steps and leave the wrong LoRA. Do NOT remove the ${loraNode} node — swap the LoRA filename inside it.`);
                    }
                }

                recipeLines.push(`\nCRITICAL: Use ONLY the nodes and CLIP type specified above for the ${fd.display_name || bestKey} family. Do NOT mix nodes or models from other families.`);

                contextParts.push(recipeLines.join('\n'));
                log(`AI Bridge: Injected FAMILY RECIPE for ${bestKey} (status: ${fd.status})`);

                // ── Blocked Family Gate ──
                // In COMPILE mode: do NOT block. Build the correct skeleton anyway.
                // The Faith Gate (validateModelAvailability) will catch missing files post-build
                // and present download links. Structure over status.
                // In legacy mode: inject STOP instruction to prevent broken workflows.
                if (fd.status === 'blocked' || fd.status === 'not_installed') {
                    const missingComponents = (fd as Record<string, unknown>).missing_details as Array<{
                        component: string;
                        known_files: string[];
                        download_url: string;
                        download_note: string;
                    }> | undefined;

                    if (isCompileMode) {
                        // Directive-First: inform the LLM about missing files but command it to build anyway.
                        // Use the first known_file from each component as the ideal filename.
                        const compileLines: string[] = [];
                        compileLines.push('');
                        compileLines.push('⚠ LOCAL FILES MISSING — BUILD ANYWAY (Directive-First Compile)');
                        compileLines.push(`The ${fd.display_name || bestKey} family has missing model files on this system.`);
                        compileLines.push('You MUST still output a valid JSON workflow using these ideal filenames:');
                        if (missingComponents && missingComponents.length > 0) {
                            for (const mc of missingComponents) {
                                const fileName = (mc.known_files && mc.known_files.length > 0) ? mc.known_files[0] : mc.component;
                                compileLines.push(`  - ${mc.component}: USE "${fileName}"`);
                            }
                        }
                        compileLines.push('The post-build Faith Gate will handle file resolution and show download links if needed.');
                        compileLines.push('CRITICAL: Do NOT refuse to build. Output the complete workflow JSON.');
                        contextParts.push(compileLines.join('\n'));
                        log(`AI Bridge: ⚡ COMPILE MODE — ${bestKey} is ${fd.status} but building skeleton anyway (directive-first)`);
                    } else {
                        const blockLines: string[] = [];
                        blockLines.push('');
                        blockLines.push('🚫 BLOCKED — DO NOT BUILD THIS WORKFLOW');
                        blockLines.push(`The ${fd.display_name || bestKey} family is BLOCKED because required model files are not installed.`);
                        if (missingComponents && missingComponents.length > 0) {
                            blockLines.push('Missing components:');
                            for (const mc of missingComponents) {
                                const fileName = (mc.known_files && mc.known_files.length > 0) ? mc.known_files[0] : mc.component;
                                blockLines.push(`  - ${mc.component}: ${fileName}`);
                                if (mc.download_url) {
                                    blockLines.push(`    Download: ${mc.download_url}`);
                                }
                                if (mc.download_note) {
                                    blockLines.push(`    Note: ${mc.download_note}`);
                                }
                            }
                        }
                        blockLines.push('');
                        blockLines.push('INSTRUCTION: Do NOT output a JSON workflow. Instead, respond in plain text explaining:');
                        blockLines.push('1. Which model family was detected and why it cannot be used');
                        blockLines.push('2. Exactly which model files are missing');
                        blockLines.push('3. Where to download them (include the URLs above)');
                        blockLines.push('4. Suggest the user install the missing models and try again');
                        contextParts.push(blockLines.join('\n'));
                        log(`AI Bridge: 🚫 BLOCKED GATE — ${bestKey} is blocked, injected DO-NOT-BUILD instruction`);
                    }
                }

                // ── Stash missing-model details for the Faith Gate ──
                // When the selected family is missing required models, log it and
                // stash the details so the Faith Gate can pass registry download URLs
                // to the ComfyUI panel (shown in the browser, not VS Code).
                if (fd.status === 'blocked' || fd.status === 'not_installed') {
                    const missingDetails = (fd as Record<string, unknown>).missing_details as Array<{
                        component: string;
                        known_files: string[];
                        download_url: string;
                        download_note: string;
                    }> | undefined;
                    if (missingDetails && missingDetails.length > 0) {
                        const fileList = missingDetails
                            .map(m => (m.known_files && m.known_files.length > 0) ? m.known_files[0] : m.component)
                            .join(', ');
                        log(`AI Bridge: ⚠ Family ${bestKey} is missing: ${fileList}`);
                        // Store on the outer scope so Faith Gate can enrich missing_models
                        (item as Record<string, unknown>)._familyMissingDetails = missingDetails;
                        (item as Record<string, unknown>)._familyDisplayName = fd.display_name || bestKey;
                    }
                }
            }
        } else if (detectedFamily) {
            log(`AI Bridge: Family "${detectedFamily}" detected but no registry match found`);
        }
    }

    // Errors — properly deserialize error log buffer objects
    const rawErrors = Array.isArray(item.errors) ? item.errors : [];
    if (rawErrors.length > 0) {
        const errorStrings = rawErrors.slice(0, 15).map((e: unknown) => {
            if (typeof e === 'string') { return e; }
            if (e && typeof e === 'object') {
                const obj = e as Record<string, unknown>;
                const msg = String(obj.message || obj.error || '');
                const nid = obj.node_id ? ` [Node #${obj.node_id}]` : '';
                const ntype = obj.node_type ? ` (${obj.node_type})` : '';
                return msg ? `${msg}${nid}${ntype}` : JSON.stringify(e);
            }
            return String(e);
        });
        contextParts.push(`Errors (${rawErrors.length}):\n${errorStrings.join('\n')}`);
    }

    // Selected nodes
    const selectedNodes = Array.isArray(item.selected_nodes) ? item.selected_nodes : [];
    if (selectedNodes.length > 0) {
        contextParts.push(`Selected nodes: ${JSON.stringify(selectedNodes)}`);
    }

    // Session history
    const history = Array.isArray(item.session_history) ? item.session_history : [];
    if (history.length > 0) {
        const recentHistory = history.slice(-5).map((h: Record<string, unknown>) =>
            `[${h.sender || '?'}]: ${String(h.text || '').substring(0, 200)}`
        ).join('\n');
        contextParts.push(`Recent chat history:\n${recentHistory}`);
    }

    const contextBlock = contextParts.join('\n\n');

    // Select mode-specific system prompt
    let systemPrompt = MODE_PROMPTS[mode] || MODE_PROMPTS['ask'];

    // ── Directive-First: Immutable Architectural Compiler ──
    // When intent === COMPILE_WORKFLOW, inject a hard directive that overrides
    // the standard build prompt. Instead of hardcoded tables, we use the
    // activeNodes/activeWiring/activeNotes computed from the registry during
    // recipe injection (Step 4b). This is the Blueprint-First approach.
    if (isCompileMode && (mode === 'build' || mode === 'modify' || mode === 'fix')) {
        const hasBlueprint = Object.keys(activeNodes).length > 0;

        // Sampler hard-coding per family+engine (registry default_sampler is already emitted,
        // but GGUF engines may need a scheduler override — e.g. beta for GGUF vs simple for standard)
        const samplerOverrides: Record<string, { sampler_name: string; scheduler: string; cfg: number; steps: number }> = {
            'FLUX1_GGUF':     { sampler_name: 'euler', scheduler: 'beta',   cfg: 1.0, steps: 20 },
            'FLUX1_STANDARD': { sampler_name: 'euler', scheduler: 'simple', cfg: 1.0, steps: 20 },
            'FLUX2_DEV_GGUF': { sampler_name: 'euler', scheduler: 'beta',   cfg: 1.0, steps: 20 },
            'FLUX2_DEV_STANDARD': { sampler_name: 'euler', scheduler: 'simple', cfg: 1.0, steps: 20 },
        };
        const samplerKey = `${archFamily}_${archEngine}`;
        const samplerOverride = samplerOverrides[samplerKey] || null;

        // Build the MANDATORY NODES block from the registry-computed activeNodes
        const mandatoryNodeLines: string[] = [];
        if (hasBlueprint) {
            mandatoryNodeLines.push(`MANDATORY NODES for ${blueprintFamilyName || archFamily} (${archEngine}):`);
            for (const [role, nodeName] of Object.entries(activeNodes)) {
                if (nodeName) {
                    mandatoryNodeLines.push(`  - ${role}: ${nodeName}`);
                }
            }
        }

        const compilerDirective = [
            '',
            '═══════════════════════════════════════════════════════',
            'DIRECTIVE: IMMUTABLE ARCHITECTURAL COMPILER',
            '═══════════════════════════════════════════════════════',
            '',
            `ROLE: You are the ComfyUI Workflow Compiler for ${blueprintFamilyName || archFamily}.`,
            'I have provided a Mandatory Blueprint from our model_family_registry.json.',
            '',
            `Architecture: family=${archFamily}, engine=${archEngine}, modality=${archModality || 'IMAGE'}`,
            '',
            // 1. Mandatory nodes from registry (NOT hardcoded)
            ...(hasBlueprint ? mandatoryNodeLines : [`Use the FAMILY RECIPE nodes for ${archFamily} with ${archEngine} engine.`]),
            '',
            // 2. Mandatory wiring from registry
            ...(activeWiring.length > 0 ? [
                'MANDATORY WIRING:',
                ...activeWiring.map(w => `  ${w}`),
                '',
            ] : []),
            // 3. Architectural notes from registry
            ...(activeNotes ? [
                'ARCHITECTURAL NOTES:',
                `  ${activeNotes}`,
                '',
            ] : []),
            'COMPILE RULES:',
            '- DO NOT suggest alternative nodes. Use ONLY the mandatory node types above.',
            '- DO NOT assume the user has the wrong files.',
            '- Build the workflow using the provided Wiring Array exactly.',
            `- If the registry says ${activeNodes.text_encode_positive || activeNodes.text_encode || 'CLIPTextEncode'} is required, do NOT use a different text encoder.`,
            '- You MUST IGNORE "no local models found" and "BLOCKED" status messages.',
            '- ALWAYS output a valid JSON workflow. Assume all required models are present.',
            `- For GGUF diffusion models, use \`models/diffusion_models/\` or \`models/unet/\` paths.`,
            '- For CLIP/text_encoders, .safetensors is valid even with GGUF diffusion loaders.',
            '- Return ONLY the valid JSON workflow wrapped in a ```json code block.',
            '',
            'FAITH GATE HANDOFF:',
            '  Once your JSON is built, the system validates model availability automatically.',
            '  If files are missing, the UI shows download links. Your ONLY job is correct nodes + wiring.',
            '',
            ...(samplerOverride ? [
                'SAMPLER HARD-CODING:',
                `  sampler_name: ${samplerOverride.sampler_name}`,
                `  scheduler: ${samplerOverride.scheduler}`,
                `  cfg: ${samplerOverride.cfg}`,
                `  steps: ${samplerOverride.steps}`,
                `  You MUST use these exact sampler settings for ${archFamily}+${archEngine}.`,
                '',
            ] : []),
            '═══════════════════════════════════════════════════════',
            '',
        ].join('\n');

        // Prepend the compiler directive to the system prompt
        systemPrompt = compilerDirective + '\n' + systemPrompt;
        log(`AI Bridge: ⚡ Injected IMMUTABLE ARCHITECTURAL COMPILER — ${Object.keys(activeNodes).filter(k => activeNodes[k]).length} mandatory nodes, ${activeWiring.length} wiring rules, sampler=${samplerKey}`);
    }

    log(`AI Bridge: ── CONTEXT BLOCK (${contextBlock.length} chars) for [${supportId}] ──`);
    log(contextBlock);
    log(`AI Bridge: ── END CONTEXT BLOCK ──`);
    log(`AI Bridge: Mode="${mode}" | System prompt length=${systemPrompt.length} chars`);

    // ── DEV/TEST RULE: Detailed diagnostic logging (Rule 7) ──
    // During development and testing, log EVERYTHING — errors, context size,
    // graph state, resources. This is mandatory for detecting and diagnosing
    // issues in code, workflows, and agent data.
    const graphNodes = Array.isArray((item.graph as any)?.nodes) ? (item.graph as any).nodes.length : 0;
    log(`AI Bridge: Context — mode=${mode}, errors=${rawErrors.length}, graph_nodes=${graphNodes}, resources=${resources ? 'yes' : 'no'}, selected_nodes=${selectedNodes.length}, history=${history.length}`);
    if (rawErrors.length > 0) {
        log(`AI Bridge: === ALL ${rawErrors.length} ERROR(S) ===`);
        for (let i = 0; i < rawErrors.length; i++) {
            const e = rawErrors[i];
            const msg = typeof e === 'string' ? e : (e as any)?.message || JSON.stringify(e);
            log(`  [${i + 1}/${rawErrors.length}] ${String(msg)}`);
        }
        log(`AI Bridge: === END ERRORS ===`);
    }
    if (graphNodes > 0 && graphNodes <= 20) {
        // For small workflows, log the node list for full visibility
        const nodeList = ((item.graph as any).nodes as any[]).map((n: any) => `${n.id}:${n.type}`).join(', ');
        log(`AI Bridge: Nodes: [${nodeList}]`);
    }

    // Build LLM messages
    const messages = [
        vscode.LanguageModelChatMessage.User(systemPrompt),
        vscode.LanguageModelChatMessage.User(
            `CONTEXT:\n${contextBlock}\n\nUSER MESSAGE:\n${userMessage}`,
        ),
    ];

    log(`AI Bridge: ── SENDING TO LLM ──`);
    log(`AI Bridge: Model: "${modelToUse.name}" (family: ${modelToUse.family}) for [${supportId}]`);
    log(`AI Bridge: User message (${userMessage.length} chars): "${userMessage}"`);
    log(`AI Bridge: Context block size: ${contextBlock.length} chars, system prompt: ${systemPrompt.length} chars`);

    let text = '';
    const MAX_LLM_ATTEMPTS = 2;
    for (let llmAttempt = 1; llmAttempt <= MAX_LLM_ATTEMPTS; llmAttempt++) {
        text = '';
        try {
            const response = await modelToUse.sendRequest(messages, {});
            for await (const part of response.stream) {
                if (part instanceof vscode.LanguageModelTextPart) {
                    text += part.value;
                }
            }
            if (text.trim()) { break; } // Got a real response
            // Empty response — retry
            log(`AI Bridge: ⚠ LLM returned empty response (attempt ${llmAttempt}/${MAX_LLM_ATTEMPTS})`);
            if (llmAttempt < MAX_LLM_ATTEMPTS) {
                log(`AI Bridge: Retrying in 2s...`);
                await new Promise(r => setTimeout(r, 2000));
            }
        } catch (sendErr: unknown) {
            const errMsg = sendErr instanceof Error ? sendErr.message : String(sendErr);

            // Retryable: "no choices", transient, rate-limit errors
            const isRetryable = /no choices|empty|timeout|rate.?limit|429|503|ECONNRESET/i.test(errMsg);
            if (isRetryable && llmAttempt < MAX_LLM_ATTEMPTS) {
                log(`AI Bridge: ⚠ LLM request failed (attempt ${llmAttempt}/${MAX_LLM_ATTEMPTS}): ${errMsg} — retrying in 3s...`);
                await new Promise(r => setTimeout(r, 3000));
                continue;
            }

            if (errMsg.toLowerCase().includes('token') || errMsg.toLowerCase().includes('exceeds') || errMsg.toLowerCase().includes('too long') || errMsg.toLowerCase().includes('limit')) {
                log(`AI Bridge: ⚠ TOKEN LIMIT ERROR: ${errMsg}`);
                log(`AI Bridge: Context was ${contextBlock.length} chars. Retrying with reduced context...`);

                // Retry with minimal context: just user message + graph summary (no models list)
                const minimalContext = contextParts.filter(p => !p.startsWith('COMFYUI-MODELS')).join('\n\n');
                const retryMessages = [
                    vscode.LanguageModelChatMessage.User(systemPrompt),
                    vscode.LanguageModelChatMessage.User(
                        `CONTEXT:\n${minimalContext}\n\nUSER MESSAGE:\n${userMessage}`,
                    ),
                ];
                log(`AI Bridge: Reduced context from ${contextBlock.length} to ${minimalContext.length} chars (removed model list)`);

                try {
                    const retryResponse = await modelToUse.sendRequest(retryMessages, {});
                    for await (const part of retryResponse.stream) {
                        if (part instanceof vscode.LanguageModelTextPart) {
                            text += part.value;
                        }
                    }
                    log(`AI Bridge: ✅ Retry succeeded with reduced context.`);
                    break;
                } catch (retryErr: unknown) {
                    const retryMsg = retryErr instanceof Error ? retryErr.message : String(retryErr);
                    log(`AI Bridge: ❌ Retry also failed: ${retryMsg}`);
                    await httpPost(`http://${host}:${port}/agent/respond`, {
                        response_type: 'CHAT',
                        text_response: `Sorry, the request was too large for the AI model even after reducing context. Try a simpler request or switch to a model with a larger context window.`,
                        support_id: supportId,
                        id: `bridge-${Date.now()}`,
                        reasoning: 'Token limit exceeded on retry',
                        model_used: modelToUse.family,
                    });
                    return;
                }
            } else {
                log(`AI Bridge: ❌ LLM request failed: ${errMsg}`);
                // Send error feedback to the ComfyUI panel instead of silently throwing
                await httpPost(`http://${host}:${port}/agent/respond`, {
                    response_type: 'CHAT',
                    text_response: `The AI model (${modelToUse.name}) failed to respond: ${errMsg}. Please try again or select a different model.`,
                    support_id: supportId,
                    id: `bridge-${Date.now()}`,
                    reasoning: `LLM error: ${errMsg}`,
                    model_used: modelToUse.family,
                });
                return;
            }
        }
    }

    text = text.trim();
    if (!text) {
        log(`AI Bridge: LLM returned empty response for [${supportId}].`);
        return;
    }

    log(`AI Bridge: ── LLM RESPONSE (${text.length} chars) for [${supportId}] ──`);
    log(text);
    log(`AI Bridge: ── END LLM RESPONSE ──`);

    // ── For Build/Modify/Fix modes, try to extract workflow JSON ──
    if (mode === 'build' || mode === 'modify' || mode === 'fix') {
        log(`AI Bridge: ── WORKFLOW EXTRACTION (mode=${mode}) ──`);
        const workflowJson = extractWorkflowJson(text);
        if (workflowJson) {
            // ── GLOBAL NaN/null/undefined SANITIZER ──
            // Scan every node's widgets_values and replace any NaN, null, or undefined
            // with safe defaults. This prevents broken widget values from ever reaching ComfyUI.
            const sanitizedNodes = Array.isArray(workflowJson.nodes) ? workflowJson.nodes as any[] : [];
            let nanFixCount = 0;
            for (const node of sanitizedNodes) {
                if (Array.isArray(node.widgets_values)) {
                    for (let i = 0; i < node.widgets_values.length; i++) {
                        const v = node.widgets_values[i];
                        if (v === null || v === undefined || (typeof v === 'number' && isNaN(v))) {
                            // Determine safe default: if the slot looks like it expects a number, use 0;
                            // if it looks like a string slot, use empty string.
                            // Heuristic: check if neighboring values give hints, otherwise default to 0.
                            const nodeType = String(node.type || '');
                            // Sampler seed slots (slot 0 for KSampler, slot 1 for KSamplerAdvanced)
                            const isSeedSlot = (nodeType === 'KSampler' && i === 0) ||
                                               (nodeType === 'KSamplerAdvanced' && i === 1);
                            // CFG slots (slot 3 for KSampler, slot 4 for KSamplerAdvanced due to control_after_generate)
                            const isCfgSlot = (nodeType === 'KSampler' && i === 3) ||
                                              (nodeType === 'KSamplerAdvanced' && i === 4);
                            if (isSeedSlot) {
                                node.widgets_values[i] = 123456789;
                                log(`AI Bridge: 🛡 NaN SANITIZER — Node #${node.id} (${nodeType}) widget[${i}] was ${v}, replaced with seed 123456789`);
                            } else if (isCfgSlot) {
                                node.widgets_values[i] = 1.0;
                                log(`AI Bridge: 🛡 NaN SANITIZER — Node #${node.id} (${nodeType}) widget[${i}] was ${v}, replaced with cfg 1.0`);
                            } else if (typeof v === 'number' || v === null || v === undefined) {
                                node.widgets_values[i] = 0;
                                log(`AI Bridge: 🛡 NaN SANITIZER — Node #${node.id} (${nodeType}) widget[${i}] was ${v}, replaced with 0`);
                            } else {
                                node.widgets_values[i] = '';
                                log(`AI Bridge: 🛡 NaN SANITIZER — Node #${node.id} (${nodeType}) widget[${i}] was ${v}, replaced with empty string`);
                            }
                            nanFixCount++;
                        }
                    }
                }
            }
            if (nanFixCount > 0) {
                log(`AI Bridge: 🛡 NaN SANITIZER — Fixed ${nanFixCount} NaN/null/undefined widget value(s) across all nodes`);
            }
            const wfNodes = Array.isArray(workflowJson.nodes) ? workflowJson.nodes as any[] : [];
            const wfLinks = Array.isArray(workflowJson.links) ? workflowJson.links as any[] : [];
            log(`AI Bridge: Extracted workflow — ${wfNodes.length} nodes, ${wfLinks.length} links`);
            if (wfNodes.length <= 30) {
                const nodeList = wfNodes.map((n: any) => `#${n.id}:${n.type || '?'}`).join(', ');
                log(`AI Bridge: Nodes: [${nodeList}]`);
            }
            // Resolve model paths against available models before validation
            const preValidationModelRes = resolveModelPaths(workflowJson, availableModels, requestedModelFamily || undefined);
            log(`AI Bridge: ── MODEL RESOLUTION (pre-validation) ──`);
            for (const r of preValidationModelRes) { log(`  ${r}`); }
            log(`AI Bridge: ── END MODEL RESOLUTION ──`);

            // Validate workflow link integrity before posting
            // ── AUTO-FIX: Ensure workflow has at least one output node ──
            const outputNodeTypes = new Set(['SaveImage', 'PreviewImage', 'SaveAnimatedWEBP', 'SaveAnimatedPNG', 'VHS_VideoCombine']);
            const wfNodesArr = Array.isArray(workflowJson.nodes) ? workflowJson.nodes as any[] : [];
            const hasOutputNode = wfNodesArr.some((n: any) => outputNodeTypes.has(String(n.type || '')));
            if (!hasOutputNode && wfNodesArr.length > 0) {
                log('AI Bridge: ⚠ MISSING OUTPUT NODE — workflow has no SaveImage/PreviewImage. Auto-adding SaveImage.');
                // Find the VAEDecode node (or last IMAGE-producing node)
                let imageSourceNode: any = null;
                let imageSourceSlot = 0;
                for (const n of wfNodesArr) {
                    if (String(n.type || '') === 'VAEDecode') {
                        imageSourceNode = n;
                        imageSourceSlot = 0; // IMAGE is slot 0
                        break;
                    }
                }
                if (imageSourceNode) {
                    const maxId = Math.max(...wfNodesArr.map((n: any) => Number(n.id) || 0));
                    const wfLinksArr = Array.isArray(workflowJson.links) ? workflowJson.links as any[] : [];
                    const maxLinkId = wfLinksArr.length > 0 ? Math.max(...wfLinksArr.map((l: any) => Number(l[0]) || 0)) : 0;
                    const newNodeId = maxId + 1;
                    const newLinkId = maxLinkId + 1;
                    // Create SaveImage node
                    const saveNode = {
                        id: newNodeId,
                        type: 'SaveImage',
                        pos: [(imageSourceNode.pos?.[0] || 0) + 400, imageSourceNode.pos?.[1] || 0],
                        size: [320, 80],
                        flags: {},
                        order: wfNodesArr.length,
                        mode: 0,
                        inputs: [
                            { name: 'images', type: 'IMAGE', link: newLinkId }
                        ],
                        outputs: [],
                        properties: { 'Node name for S&R': 'SaveImage' },
                        widgets_values: ['ComfyUI']
                    };
                    // Wire VAEDecode → SaveImage
                    const newLink = [newLinkId, imageSourceNode.id, imageSourceSlot, newNodeId, 0, 'IMAGE'];
                    // Update source node's output links
                    if (Array.isArray(imageSourceNode.outputs)) {
                        const srcOutput = imageSourceNode.outputs[imageSourceSlot];
                        if (srcOutput && Array.isArray(srcOutput.links)) {
                            srcOutput.links.push(newLinkId);
                        } else if (srcOutput) {
                            srcOutput.links = [newLinkId];
                        }
                    }
                    wfNodesArr.push(saveNode);
                    wfLinksArr.push(newLink);
                    workflowJson.nodes = wfNodesArr;
                    workflowJson.links = wfLinksArr;
                    log(`AI Bridge: ✅ Auto-added SaveImage node #${newNodeId} with link ${newLinkId} (VAEDecode #${imageSourceNode.id} → SaveImage)`);
                } else {
                    log('AI Bridge: ⚠ No VAEDecode found to wire SaveImage to — workflow may fail with prompt_no_outputs');
                }
            }

            log(`AI Bridge: ── WORKFLOW VALIDATION ──`);
            const linkErrors = validateWorkflowLinks(workflowJson);
            const modelErrors = validateModelCompatibility(workflowJson, requestedModelFamily);
            const availabilityErrors = validateModelAvailability(workflowJson, availableModels);
            if (modelErrors.length > 0) {
                log(`AI Bridge: ── MODEL COMPATIBILITY ──`);
                for (const me of modelErrors) { log(`  ⚠ ${me}`); }
            }
            if (availabilityErrors.length > 0) {
                log(`AI Bridge: ── MODEL AVAILABILITY ──`);
                for (const me of availabilityErrors) { log(`  ⚠ ${me}`); }
            }
            const validationErrors = [...linkErrors, ...modelErrors, ...availabilityErrors];
            if (validationErrors.length > 0) {
                log(`AI Bridge: Workflow validation found ${validationErrors.length} issue(s) for [${supportId}]`);
                for (const err of validationErrors) {
                    log(`  ⚠ VALIDATION: ${err}`);
                }
                // Feed validation errors back to LLM for self-correction
                log(`AI Bridge: Requesting LLM self-correction for [${supportId}]...`);
                const fixMessages = [
                    vscode.LanguageModelChatMessage.User(systemPrompt),
                    vscode.LanguageModelChatMessage.User(
                        `CONTEXT:\n${contextBlock}\n\nUSER MESSAGE:\n${userMessage}`,
                    ),
                    vscode.LanguageModelChatMessage.User(
                        `Your previous workflow JSON had ${validationErrors.length} validation error(s) (including missing models or wiring issues):\n${validationErrors.map((e, i) => `${i + 1}. ${e}`).join('\n')}\n\nPlease output the CORRECTED workflow JSON. If a model is missing, REPLACE it with an available one from the CONTEXT list if possible. Wrap JSON in a \`\`\`json code block.`,
                    ),
                ];
                try {
                    const fixResponse = await modelToUse.sendRequest(fixMessages, {});
                    let fixText = '';
                    for await (const part of fixResponse.stream) {
                        if (part instanceof vscode.LanguageModelTextPart) {
                            fixText += part.value;
                        }
                    }
                    fixText = fixText.trim();
                    const fixedWorkflow = extractWorkflowJson(fixText);
                    if (fixedWorkflow) {
                        // ── NaN SANITIZER (self-corrected path) ──
                        const fixSanitizedNodes = Array.isArray(fixedWorkflow.nodes) ? fixedWorkflow.nodes as any[] : [];
                        let fixNanCount = 0;
                        for (const node of fixSanitizedNodes) {
                            if (Array.isArray(node.widgets_values)) {
                                for (let i = 0; i < node.widgets_values.length; i++) {
                                    const v = node.widgets_values[i];
                                    if (v === null || v === undefined || (typeof v === 'number' && isNaN(v))) {
                                        const nodeType = String(node.type || '');
                                        const isSeedSlot = (nodeType === 'KSampler' && i === 0) || (nodeType === 'KSamplerAdvanced' && i === 1);
                                        const isCfgSlot = (nodeType === 'KSampler' && i === 3) || (nodeType === 'KSamplerAdvanced' && i === 4);
                                        if (isSeedSlot) { node.widgets_values[i] = 123456789; }
                                        else if (isCfgSlot) { node.widgets_values[i] = 1.0; }
                                        else if (typeof v === 'number' || v === null || v === undefined) { node.widgets_values[i] = 0; }
                                        else { node.widgets_values[i] = ''; }
                                        fixNanCount++;
                                        log(`AI Bridge: 🛡 NaN SANITIZER (fix) — Node #${node.id} (${nodeType}) widget[${i}] was ${v}, replaced`);
                                    }
                                }
                            }
                        }
                        if (fixNanCount > 0) {
                            log(`AI Bridge: 🛡 NaN SANITIZER (fix) — Fixed ${fixNanCount} NaN/null/undefined value(s) in self-corrected workflow`);
                        }
                        const fixModelRes = resolveModelPaths(fixedWorkflow, availableModels, requestedModelFamily || undefined);
                        log(`AI Bridge: ── MODEL RESOLUTION (self-corrected) ──`);
                        for (const r of fixModelRes) { log(`  ${r}`); }
                        const reFixLinks = validateWorkflowLinks(fixedWorkflow);
                        const reFixModels = validateModelCompatibility(fixedWorkflow, requestedModelFamily);
                        const reFixMissing = validateModelAvailability(fixedWorkflow, availableModels);
                        const revalidation = [...reFixLinks, ...reFixModels, ...reFixMissing];
                        if (revalidation.length === 0) {
                            log(`AI Bridge: ✅ Self-correction succeeded — ${validationErrors.length} errors fixed.`);
                            log(`AI Bridge: ── CORRECTED LLM RESPONSE (${fixText.length} chars) ──`);
                            log(fixText);
                            log(`AI Bridge: ── END CORRECTED RESPONSE ──`);

                            // Use the corrected workflow instead
                            const jsonBlockStart = fixText.indexOf('\`\`\`json');
                            const textExplanation = jsonBlockStart > 0
                                ? fixText.substring(0, jsonBlockStart).trim()
                                : text.substring(0, text.indexOf('\`\`\`json')).trim() || 'Workflow corrected by Architect.';

                            saveWorkflowLog(fixedWorkflow, supportId, mode, modelToUse.family, 'self-corrected');
                            const result = await httpPost(`http://${host}:${port}/agent/respond`, {
                                response_type: 'ACTION',
                                text_response: textExplanation,
                                operation: { type: 'overwrite', workflow: fixedWorkflow },
                                support_id: supportId,
                                id: `bridge-${Date.now()}`,
                                reasoning: `${mode} workflow (self-corrected) via ${modelToUse.name}`,
                                model_used: modelToUse.family,
                            });
                            log(`AI Bridge: Corrected ACTION posted for [${supportId}] — listener says: ${result}`);
                            log(`AI Bridge: ═══════ REQUEST [${supportId}] COMPLETE (self-corrected) ═══════`);
                            return;
                        } else {
                            log(`AI Bridge: ❌ Self-correction still has ${revalidation.length} error(s).`);
                            
                            // Check if the remaining errors are MISSING MODELS
                            if (reFixMissing.length > 0) {
                                // Fallback to Faith Gate Modal
                                const familyMissingDetails = (item as Record<string, unknown>)._familyMissingDetails as Array<{
                                    component: string; known_files: string[]; download_url: string; download_note: string;
                                }> | undefined;
                                const missingModelEntries = extractMissingModelEntriesFromErrors(reFixMissing, familyMissingDetails);
                                log(`AI Bridge: ⛔ Faith Gate (post-correction): Still missing models. Blocking build.`);
                                const result = await httpPost(`http://${host}:${port}/agent/respond`, {
                                    response_type: 'ACTION',
                                    text_response: `Self-correction failed to resolve missing models. Please download the required assets.`,
                                    operation: { type: 'overwrite', workflow: fixedWorkflow },
                                    preflight_gate: 'missing_models',
                                    missing_models: missingModelEntries,
                                    support_id: supportId,
                                    id: `bridge-${Date.now()}`,
                                    reasoning: `Faith Gate blocked ${mode} (missing models after self-correction)`,
                                    model_used: modelToUse.family,
                                });
                                log(`AI Bridge: Faith Gate payload posted for [${supportId}] — listener says: ${result}`);
                                log(`AI Bridge: ═══════ REQUEST [${supportId}] COMPLETE (preflight-missing-models) ═══════`);
                                return;
                            }

                            log(`AI Bridge: ⛔ Blocking ACTION post because workflow is still invalid.`);
                            const result = await httpPost(`http://${host}:${port}/agent/respond`, {
                                response_type: 'CHAT',
                                text_response: `I attempted to fix the workflow but it is still invalid.\n\nRemaining errors (${revalidation.length}):\n${revalidation.map((e, i) => `${i + 1}. ${e}`).join('\n')}\n\nPlease check your installed models or try a simpler request.`,
                                support_id: supportId,
                                id: `bridge-${Date.now()}`,
                                reasoning: `Blocked invalid ${mode} workflow after failed self-correction`,
                                model_used: modelToUse.family,
                            });
                            log(`AI Bridge: CHAT validation error response posted for [${supportId}] — listener says: ${result}`);
                            log(`AI Bridge: ═══════ REQUEST [${supportId}] COMPLETE (blocked-invalid-workflow) ═══════`);
                            flushRequestLog(mode);
                            return;
                        }
                    } else {
                        log(`AI Bridge: Self-correction produced no valid workflow. Blocking ACTION post.`);
                        const result = await httpPost(`http://${host}:${port}/agent/respond`, {
                            response_type: 'CHAT',
                            text_response: `I blocked this update because self-correction did not return valid workflow JSON.\n\nOriginal validation errors (${validationErrors.length}):\n${validationErrors.map((e, i) => `${i + 1}. ${e}`).join('\n')}\n\nNo workflow was applied.`,
                            support_id: supportId,
                            id: `bridge-${Date.now()}`,
                            reasoning: `Blocked invalid ${mode} workflow (no valid self-correction JSON)`,
                            model_used: modelToUse.family,
                        });
                        log(`AI Bridge: CHAT validation error response posted for [${supportId}] — listener says: ${result}`);
                        log(`AI Bridge: ═══════ REQUEST [${supportId}] COMPLETE (blocked-invalid-workflow) ═══════`);
                        flushRequestLog(mode);
                        return;
                    }
                } catch (fixErr: unknown) {
                    const fixMsg = fixErr instanceof Error ? fixErr.message : String(fixErr);
                    log(`AI Bridge: Self-correction request failed — ${fixMsg}. Blocking ACTION post.`);
                    const result = await httpPost(`http://${host}:${port}/agent/respond`, {
                        response_type: 'CHAT',
                        text_response: `I blocked this update because workflow validation failed and the self-correction request failed.\n\nValidation errors (${validationErrors.length}):\n${validationErrors.map((e, i) => `${i + 1}. ${e}`).join('\n')}\n\nNo workflow was applied.`,
                        support_id: supportId,
                        id: `bridge-${Date.now()}`,
                        reasoning: `Blocked invalid ${mode} workflow after self-correction request failure`,
                        model_used: modelToUse.family,
                    });
                    log(`AI Bridge: CHAT validation error response posted for [${supportId}] — listener says: ${result}`);
                    log(`AI Bridge: ═══════ REQUEST [${supportId}] COMPLETE (blocked-invalid-workflow) ═══════`);
                    flushRequestLog(mode);
                    return;
                }
            } else {
                log(`AI Bridge: ✅ Workflow validation PASSED — 0 errors`);
            }

            log(`AI Bridge: Model paths already resolved during pre-validation.`);

            // Extract the text explanation (everything before the JSON block)
            const jsonBlockStart = text.indexOf('```json');
            const textExplanation = jsonBlockStart > 0
                ? text.substring(0, jsonBlockStart).trim()
                : (mode === 'build' ? 'Workflow built by Architect.' : mode === 'fix' ? 'Workflow fixed by Architect.' : 'Workflow modified by Architect.');

            log(`AI Bridge: Extracted workflow JSON (${JSON.stringify(workflowJson).length} bytes) — posting as ACTION`);
            log(`AI Bridge: Text explanation: "${textExplanation}"`);
            log(`AI Bridge: Reasoning: ${mode === 'build' ? 'Built' : mode === 'fix' ? 'Fixed' : 'Modified'} workflow via ${modelToUse.name}`);
            saveWorkflowLog(workflowJson, supportId, mode, modelToUse.family, 'initial');

            const result = await httpPost(`http://${host}:${port}/agent/respond`, {
                response_type: 'ACTION',
                text_response: textExplanation,
                operation: {
                    type: 'overwrite',
                    workflow: workflowJson,
                },
                support_id: supportId,
                id: `bridge-${Date.now()}`,
                reasoning: `${mode === 'build' ? 'Built' : mode === 'fix' ? 'Fixed' : 'Modified'} workflow via ${modelToUse.name}`,
                model_used: modelToUse.family,
            });

            log(`AI Bridge: ACTION response posted for [${supportId}] — listener says: ${result}`);
            log(`AI Bridge: ═══════════════════════════════════════════════════════`);
            log(`AI Bridge: REQUEST [${supportId}] COMPLETE (ACTION)`);
            log(`AI Bridge: ═══════════════════════════════════════════════════════`);
            flushRequestLog(mode);
            return;
        } else {
            log(`AI Bridge: ⚠ Mode=${mode} but no valid workflow JSON extracted. Full LLM text was logged above. Falling back to CHAT.`);
        }
    }

    // POST the response back to the listener as CHAT
    const result = await httpPost(`http://${host}:${port}/agent/respond`, {
        response_type: 'CHAT',
        text_response: text,
        support_id: supportId,
        id: `bridge-${Date.now()}`,
        reasoning: `Auto-bridged via ${modelToUse.name}`,
        model_used: modelToUse.family,
    });

    log(`AI Bridge: CHAT response posted for [${supportId}] — listener says: ${result}`);
    log(`AI Bridge: ═══════════════════════════════════════════════════════`);
    log(`AI Bridge: REQUEST [${supportId}] COMPLETE`);
    log(`AI Bridge: ═══════════════════════════════════════════════════════`);
    flushRequestLog(mode);
}

/**
 * Resolve model paths in a workflow against available models on the system.
 * Scans nodes that use model widgets (CheckpointLoaderSimple, LoraLoader, etc.),
 * fuzzy-matches model names against the available models, and replaces with the
 * correct filename. Returns a list of resolution log entries.
 */
function resolveModelPaths(
    workflow: Record<string, unknown>,
    availableModels: Record<string, string[]> | undefined,
    requestedFamily?: string,
): string[] {
    const resolutions: string[] = [];
    if (!availableModels || typeof availableModels !== 'object') {
        resolutions.push('No available models provided — skipping model resolution.');
        return resolutions;
    }

    // Map node types to the model folders they can load from, and the widget index
    // Uses the same multi-category approach as validateModelAvailability so
    // resolveModelPaths searches the SAME folders that the validator checks.
    const MODEL_NODE_MAP: Record<string, { categories: string[]; widgetIndex: number }[]> = {
        'CheckpointLoaderSimple': [{ categories: ['checkpoints'], widgetIndex: 0 }],
        'CheckpointLoader': [{ categories: ['checkpoints'], widgetIndex: 0 }],
        'UNETLoader': [{ categories: ['unet', 'unet_gguf', 'diffusion_models', 'checkpoints'], widgetIndex: 0 }],
        'UnetLoaderGGUF': [{ categories: ['unet', 'unet_gguf', 'diffusion_models', 'checkpoints'], widgetIndex: 0 }],
        'UnetLoaderGGUFAdvanced': [{ categories: ['unet', 'unet_gguf', 'diffusion_models', 'checkpoints'], widgetIndex: 0 }],
        'LoraLoader': [{ categories: ['loras'], widgetIndex: 0 }],
        'LoraLoaderModelOnly': [{ categories: ['loras'], widgetIndex: 0 }],
        'ControlNetLoader': [{ categories: ['controlnet'], widgetIndex: 0 }],
        'VAELoader': [{ categories: ['vae'], widgetIndex: 0 }],
        'CLIPLoader': [{ categories: ['clip', 'clip_gguf', 'text_encoders'], widgetIndex: 0 }],
        'CLIPLoaderGGUF': [{ categories: ['clip', 'clip_gguf', 'text_encoders'], widgetIndex: 0 }],
        'UpscaleModelLoader': [{ categories: ['upscale_models'], widgetIndex: 0 }],
        'StyleModelLoader': [{ categories: ['style_models'], widgetIndex: 0 }],
        'CLIPVisionLoader': [{ categories: ['clip_vision'], widgetIndex: 0 }],
        'unCLIPCheckpointLoader': [{ categories: ['checkpoints'], widgetIndex: 0 }],
        'DualCLIPLoader': [{ categories: ['clip', 'clip_gguf', 'text_encoders'], widgetIndex: 0 }, { categories: ['clip', 'clip_gguf', 'text_encoders'], widgetIndex: 1 }],
        'DualCLIPLoaderGGUF': [{ categories: ['clip', 'clip_gguf', 'text_encoders'], widgetIndex: 0 }, { categories: ['clip', 'clip_gguf', 'text_encoders'], widgetIndex: 1 }],
        'TripleCLIPLoader': [{ categories: ['clip', 'clip_gguf', 'text_encoders'], widgetIndex: 0 }, { categories: ['clip', 'clip_gguf', 'text_encoders'], widgetIndex: 1 }, { categories: ['clip', 'clip_gguf', 'text_encoders'], widgetIndex: 2 }],
    };

    // Path normalization helper — normalize backslash to forward slash for comparison
    const _bslash = String.fromCharCode(92);
    const normPath = (p: string) => p.split(_bslash).join('/');
    // File extension extractor
    const getExt = (p: string) => { const i = p.lastIndexOf('.'); if (i < 0) { return ''; } const e = p.substring(i + 1); return e.toLowerCase(); };

    // Build a flat lookup: category → list of exact filenames
    const modelLookup = new Map<string, string[]>();
    for (const [cat, files] of Object.entries(availableModels)) {
        if (Array.isArray(files)) {
            modelLookup.set(cat.toLowerCase(), files);
        }
    }

    const nodes = Array.isArray(workflow.nodes) ? workflow.nodes as any[] : [];
    for (const node of nodes) {
        const nodeType = String(node.type || '');
        const mappings = MODEL_NODE_MAP[nodeType];
        if (!mappings || !Array.isArray(node.widgets_values)) { continue; }

        for (const mapping of mappings) {
            const { categories, widgetIndex } = mapping;
            if (widgetIndex >= node.widgets_values.length) { continue; }

            const currentValue = String(node.widgets_values[widgetIndex] || '');
            if (!currentValue) { continue; }

            // Collect all available files from ALL relevant categories for this node type
            const availableFiles: string[] = [];
            const matchedCats: string[] = [];
            for (const cat of categories) {
                const files = modelLookup.get(cat.toLowerCase());
                if (files && files.length > 0) {
                    availableFiles.push(...files);
                    matchedCats.push(cat);
                }
            }
            // Deduplicate
            const uniqueFiles = [...new Set(availableFiles)];
            const catLabel = matchedCats.join(', ') || categories.join(', ');

            if (uniqueFiles.length === 0) {
                resolutions.push(`Node #${node.id} (${nodeType}): No models in [${catLabel}] available on system — keeping "${currentValue}"`);
                continue;
            }

            // ── GGUF format advisory ──
            // GGUF unet loader nodes (UnetLoaderGGUF, UnetLoaderGGUFAdvanced) ideally
            // use .gguf files, but they CAN also load .safetensors — so we only WARN,
            // never auto-replace (auto-replace caused cross-family disasters).
            // CLIP loaders (DualCLIPLoaderGGUF, CLIPLoaderGGUF) work fine with .safetensors
            // CLIP files — no warning needed for those.
            const ggufUnetNodes = new Set(['UnetLoaderGGUF', 'UnetLoaderGGUFAdvanced']);
            const currentFileExt = getExt(currentValue);
            if (ggufUnetNodes.has(nodeType) && currentFileExt && currentFileExt !== 'gguf') {
                resolutions.push(`Node #${node.id} (${nodeType}): ⚠ GGUF unet loader has non-GGUF file "${currentValue}" — this may work but a .gguf file is preferred`);
                // Do NOT auto-replace — fall through to normal exact-match logic
            }

            // Exact match check (with path normalization)
            const normalizedCurrent = normPath(currentValue);
            const exactMatch = uniqueFiles.find(f => f === currentValue || normPath(f) === normalizedCurrent);
            if (exactMatch) {
                if (exactMatch !== currentValue) {
                    resolutions.push(`Node #${node.id} (${nodeType}): ✅ "${currentValue}" → "${exactMatch}" (path normalization)`);
                    node.widgets_values[widgetIndex] = exactMatch;
                } else {
                    resolutions.push(`Node #${node.id} (${nodeType}): ✅ "${currentValue}" — exact match in [${catLabel}]`);
                }
                continue;
            }

            // Fuzzy match: score each available file
            const currentExt = getExt(currentValue);
            const currentLower = currentValue.toLowerCase().replace(/\.[^.]+$/, ''); // strip extension
            const currentTokens = currentLower.split(/[\s_\-\\.\/\\]+/).filter(t => t.length > 1);

            let bestMatch = '';
            let bestScore = 0;

            for (const candidate of uniqueFiles) {
                // Extension guard: never fuzzy-match across format types
                // e.g. never match a .gguf request to a .safetensors candidate
                const candExt = getExt(candidate);
                if (currentExt && candExt && currentExt !== candExt) { continue; }

                const candLower = candidate.toLowerCase().replace(/\.[^.]+$/, '');
                const candTokens = candLower.split(/[\s_\-\\.\/\\]+/).filter(t => t.length > 1);

                // Score: count matching tokens
                let score = 0;
                for (const ct of currentTokens) {
                    if (candTokens.some(t => t.includes(ct) || ct.includes(t))) {
                        score += 2;
                    } else if (candLower.includes(ct)) {
                        score += 1;
                    }
                }

                // Bonus for similar length (penalize wildly different names)
                if (Math.abs(candLower.length - currentLower.length) < 10) { score += 1; }

                if (score > bestScore) {
                    bestScore = score;
                    bestMatch = candidate;
                }
            }

            // ── Family guard: never fuzzy-match models across model families ──
            // If we know the requested family (e.g. FLUX2), do NOT swap a FLUX2 model
            // for a FLUX1 one just because it's the best fuzzy score.
            // Applies to ALL model-loading nodes (checkpoints, clips, VAEs, loras).
            const familyGuardedNodes = new Set(['CheckpointLoaderSimple', 'CheckpointLoader', 'unCLIPCheckpointLoader',
                'UNETLoader', 'UnetLoaderGGUF', 'UnetLoaderGGUFAdvanced',
                'CLIPLoader', 'DualCLIPLoader', 'TripleCLIPLoader', 'CLIPLoaderGGUF',
                'VAELoader', 'LoraLoader', 'LoraLoaderModelOnly']);
            if (requestedFamily && bestMatch && familyGuardedNodes.has(nodeType)) {
                // Detect family of the best match candidate
                const FAMILY_DETECT: { pattern: RegExp; family: string }[] = [
                    { pattern: /sdxl|sd[_\-]?xl|juggernaut.?xl|realvis.?xl/i, family: 'SDXL' },
                    { pattern: /sd3\.?5?|sd[_\-]?3\.?5/i, family: 'SD3' },
                    { pattern: /v1[\-_]5|sd[\-_]?1\.?5/i, family: 'SD15' },
                    { pattern: /flux[_\-]?2|flux\.?2|Flux2|FLUX2/i, family: 'FLUX2' },
                    { pattern: /flux/i, family: 'FLUX1' },
                    { pattern: /qwen/i, family: 'QWEN' },
                    { pattern: /hunyuan/i, family: 'HUNYUAN' },
                    { pattern: /wan/i, family: 'WAN' },
                    { pattern: /chroma/i, family: 'CHROMA' },
                ];
                const matchFamily = FAMILY_DETECT.find(fd => fd.pattern.test(bestMatch))?.family;
                if (matchFamily && matchFamily !== requestedFamily) {
                    resolutions.push(`Node #${node.id} (${nodeType}): ⛔ "${currentValue}" — best fuzzy match "${bestMatch}" is ${matchFamily} but requested family is ${requestedFamily}. Keeping original (missing model).`);
                    continue;
                }
            }

            // Only auto-resolve if score is decent (at least 2 token matches)
            if (bestScore >= 2 && bestMatch) {
                resolutions.push(`Node #${node.id} (${nodeType}): 🔄 "${currentValue}" → "${bestMatch}" (fuzzy match, score=${bestScore})`);
                node.widgets_values[widgetIndex] = bestMatch;
            } else {
                // No good match — keep original, log warning
                resolutions.push(`Node #${node.id} (${nodeType}): ⚠ "${currentValue}" not found in [${catLabel}] (${uniqueFiles.length} available). Best match "${bestMatch}" score=${bestScore} — keeping original.`);
            }
        }
    }

    return resolutions;
}

/**
 * Node wiring specification — maps node types to their exact connectable
 * input/output slots with expected data types.  Used by validateWorkflowLinks()
 * to catch type-mismatch wiring errors the LLM commonly makes.
 */
const NODE_WIRING_SPEC: Record<string, { inputs: { name: string; type: string }[]; outputs: { name: string; type: string }[] }> = {
    CheckpointLoaderSimple:    { inputs: [], outputs: [{ name: 'MODEL', type: 'MODEL' }, { name: 'CLIP', type: 'CLIP' }, { name: 'VAE', type: 'VAE' }] },
    UnetLoaderGGUFAdvanced:    { inputs: [], outputs: [{ name: 'MODEL', type: 'MODEL' }] },
    UNETLoader:                { inputs: [], outputs: [{ name: 'MODEL', type: 'MODEL' }] },
    UnetLoaderGGUF:            { inputs: [], outputs: [{ name: 'MODEL', type: 'MODEL' }] },
    CLIPLoader:                { inputs: [], outputs: [{ name: 'CLIP', type: 'CLIP' }] },
    CLIPLoaderGGUF:            { inputs: [], outputs: [{ name: 'CLIP', type: 'CLIP' }] },
    DualCLIPLoader:            { inputs: [], outputs: [{ name: 'CLIP', type: 'CLIP' }] },
    DualCLIPLoaderGGUF:        { inputs: [], outputs: [{ name: 'CLIP', type: 'CLIP' }] },
    TripleCLIPLoader:          { inputs: [], outputs: [{ name: 'CLIP', type: 'CLIP' }] },
    CLIPTextEncode:            { inputs: [{ name: 'clip', type: 'CLIP' }], outputs: [{ name: 'CONDITIONING', type: 'CONDITIONING' }] },
    KSampler:                  { inputs: [{ name: 'model', type: 'MODEL' }, { name: 'positive', type: 'CONDITIONING' }, { name: 'negative', type: 'CONDITIONING' }, { name: 'latent_image', type: 'LATENT' }], outputs: [{ name: 'LATENT', type: 'LATENT' }] },
    KSamplerAdvanced:          { inputs: [{ name: 'model', type: 'MODEL' }, { name: 'positive', type: 'CONDITIONING' }, { name: 'negative', type: 'CONDITIONING' }, { name: 'latent_image', type: 'LATENT' }], outputs: [{ name: 'LATENT', type: 'LATENT' }] },
    EmptyLatentImage:          { inputs: [], outputs: [{ name: 'LATENT', type: 'LATENT' }] },
    EmptySD3LatentImage:       { inputs: [], outputs: [{ name: 'LATENT', type: 'LATENT' }] },
    VAELoader:                 { inputs: [], outputs: [{ name: 'VAE', type: 'VAE' }] },
    VAEDecode:                 { inputs: [{ name: 'samples', type: 'LATENT' }, { name: 'vae', type: 'VAE' }], outputs: [{ name: 'IMAGE', type: 'IMAGE' }] },
    VAEEncode:                 { inputs: [{ name: 'pixels', type: 'IMAGE' }, { name: 'vae', type: 'VAE' }], outputs: [{ name: 'LATENT', type: 'LATENT' }] },
    LoraLoader:                { inputs: [{ name: 'model', type: 'MODEL' }, { name: 'clip', type: 'CLIP' }], outputs: [{ name: 'MODEL', type: 'MODEL' }, { name: 'CLIP', type: 'CLIP' }] },
    LoraLoaderModelOnly:       { inputs: [{ name: 'model', type: 'MODEL' }], outputs: [{ name: 'MODEL', type: 'MODEL' }] },
    ControlNetLoader:          { inputs: [], outputs: [{ name: 'CONTROL_NET', type: 'CONTROL_NET' }] },
    ControlNetApplyAdvanced:   { inputs: [{ name: 'positive', type: 'CONDITIONING' }, { name: 'negative', type: 'CONDITIONING' }, { name: 'control_net', type: 'CONTROL_NET' }, { name: 'image', type: 'IMAGE' }], outputs: [{ name: 'CONDITIONING', type: 'CONDITIONING' }, { name: 'CONDITIONING', type: 'CONDITIONING' }] },
    DWPreprocessor:            { inputs: [{ name: 'image', type: 'IMAGE' }], outputs: [{ name: 'IMAGE', type: 'IMAGE' }, { name: 'POSE_KEYPOINT', type: 'POSE_KEYPOINT' }] },
    SetUnionControlNetType:    { inputs: [{ name: 'control_net', type: 'CONTROL_NET' }], outputs: [{ name: 'CONTROL_NET', type: 'CONTROL_NET' }] },
    PreviewImage:              { inputs: [{ name: 'images', type: 'IMAGE' }], outputs: [] },
    SaveImage:                 { inputs: [{ name: 'images', type: 'IMAGE' }], outputs: [] },
    LoadImage:                 { inputs: [], outputs: [{ name: 'IMAGE', type: 'IMAGE' }, { name: 'MASK', type: 'MASK' }] },
    UpscaleModelLoader:        { inputs: [], outputs: [{ name: 'UPSCALE_MODEL', type: 'UPSCALE_MODEL' }] },
    ImageUpscaleWithModel:     { inputs: [{ name: 'upscale_model', type: 'UPSCALE_MODEL' }, { name: 'image', type: 'IMAGE' }], outputs: [{ name: 'IMAGE', type: 'IMAGE' }] },
    CLIPSetLastLayer:          { inputs: [{ name: 'clip', type: 'CLIP' }], outputs: [{ name: 'CLIP', type: 'CLIP' }] },
    ConditioningCombine:       { inputs: [{ name: 'cond1', type: 'CONDITIONING' }, { name: 'cond2', type: 'CONDITIONING' }], outputs: [{ name: 'CONDITIONING', type: 'CONDITIONING' }] },
    LatentUpscale:             { inputs: [{ name: 'samples', type: 'LATENT' }], outputs: [{ name: 'LATENT', type: 'LATENT' }] },
    ImageScale:                { inputs: [{ name: 'image', type: 'IMAGE' }], outputs: [{ name: 'IMAGE', type: 'IMAGE' }] },
};

/**
 * Model family patterns — maps regex patterns to model families.
 * Used to detect incompatible model mixing (e.g. Qwen unet + SD1.5 CLIP + SDXL VAE).
 */
const MODEL_FAMILY_PATTERNS: { pattern: RegExp; family: string }[] = [
    // SD 1.5 family
    { pattern: /v1[\-_]5|sd[\-_]?1\.?5|dreamshaper|deliberate|realistic.?vision(?!xl)|control_sd15|control_v11p_sd15/i, family: 'SD15' },
    // SDXL family
    { pattern: /sdxl|sd[_\-]?xl|juggernaut.?xl|realvis.?xl|playground.?v2|ssd[_-]1b|canny_sdxl|controlnet.?union.?sdxl/i, family: 'SDXL' },
    // SD3 / SD3.5 family (must be before FLUX to avoid ae.safetensors capturing SD3)
    { pattern: /sd3\.?5?|sd[_\-]?3\.?5/i, family: 'SD3' },
    // FLUX.2 family (must be before FLUX1 — more specific)
    { pattern: /flux[_\-]?2|flux\.?2|Flux2|FLUX2/i, family: 'FLUX2' },
    // FLUX.1 family
    { pattern: /flux[1_\-]|flux\.1|(?:^|[\\/])ae\.safetensors$|FLUX1|FLUX[/\\](?!2)/i, family: 'FLUX1' },
    // Shared FLUX encoders (t5xxl is used by both FLUX1 and FLUX2 — classify as FLUX1 by default)
    { pattern: /t5xxl/i, family: 'FLUX1' },
    // Qwen family
    { pattern: /qwen/i, family: 'QWEN' },
    // Hunyuan family (Video, Image 2.1, 3D)
    { pattern: /hunyuan/i, family: 'HUNYUAN' },
    // Z-Image family
    { pattern: /z[\-_]image/i, family: 'Z-IMAGE' },
    // WAN family
    { pattern: /wan[_\-]?2/i, family: 'WAN' },
    // Chroma family (modified FLUX arch, uses t5xxl only)
    { pattern: /chroma/i, family: 'CHROMA' },
    // Omnigen2 family
    { pattern: /omnigen/i, family: 'OMNIGEN2' },
];

/** Known compatible CLIP/text-encoder families for each model family */
const CLIP_COMPATIBILITY: Record<string, string[]> = {
    SD15:       ['SD15'],
    SDXL:       ['SDXL'],
    SD3:        ['SD3'],
    FLUX1:      ['FLUX1'],
    FLUX2:      ['FLUX2'],
    QWEN:       ['QWEN'],
    HUNYUAN:    ['HUNYUAN'],
    'Z-IMAGE':  ['Z-IMAGE'],
    WAN:        ['WAN'],
    CHROMA:     ['CHROMA', 'FLUX1'],     // Chroma uses FLUX1's t5xxl text encoder
    OMNIGEN2:   ['OMNIGEN2', 'FLUX1'],   // OmniGen2 uses FLUX1's t5xxl text encoder
};

/** Known compatible VAE families for each model family */
const VAE_COMPATIBILITY: Record<string, string[]> = {
    SD15:       ['SD15', 'SDXL'],
    SDXL:       ['SDXL'],
    SD3:        ['SD3'],
    FLUX1:      ['FLUX1'],
    FLUX2:      ['FLUX2'],
    QWEN:       ['QWEN'],
    HUNYUAN:    ['HUNYUAN'],
    'Z-IMAGE':  ['Z-IMAGE', 'FLUX1'],
    WAN:        ['WAN'],
    CHROMA:     ['CHROMA', 'FLUX1'],
    OMNIGEN2:   ['OMNIGEN2', 'FLUX1'],
};

/** Known compatible ControlNet families */
const CONTROLNET_COMPATIBILITY: Record<string, string[]> = {
    SD15:    ['SD15'],
    SDXL:    ['SDXL'],
    SD3:     ['SD3'],
    FLUX1:   ['FLUX1'],
    FLUX2:   ['FLUX2'],
    QWEN:    ['QWEN'],
};

function classifyModelFamily(filename: string): string | null {
    if (!filename) { return null; }
    for (const { pattern, family } of MODEL_FAMILY_PATTERNS) {
        if (pattern.test(filename)) { return family; }
    }
    // Generic CLIP models are ambiguous — don't classify
    if (/clip_l|clip_g|clip_h/i.test(filename)) { return null; }
    return null;
}

/**
 * Validate that all models in the workflow belong to compatible families.
 * Catches mixing like Qwen unet + SD1.5 CLIP + SDXL VAE.
 * Returns an array of error strings (empty = compatible).
 */
function validateModelCompatibility(workflow: Record<string, unknown>, requestedFamily?: string | null): string[] {
    const errors: string[] = [];
    const nodes = Array.isArray(workflow.nodes) ? workflow.nodes as any[] : [];

    // Collect model families per role
    const modelFamilies: { role: string; nodeId: number; nodeType: string; model: string; family: string }[] = [];

    for (const node of nodes) {
        const nodeType = (node.type as string) || '';
        const nodeId = node.id as number;
        const widgets = Array.isArray(node.widgets_values) ? node.widgets_values : [];

        // Checkpoint loader — widget[0] is the model
        if (/CheckpointLoader/i.test(nodeType) && widgets.length > 0) {
            const model = String(widgets[0] || '');
            const fam = classifyModelFamily(model);
            if (fam) { modelFamilies.push({ role: 'checkpoint', nodeId, nodeType, model, family: fam }); }
        }
        // Unet/diffusion loaders — widget[0] is the model
        if (/Unet|UNETLoader/i.test(nodeType) && widgets.length > 0) {
            const model = String(widgets[0] || '');
            const fam = classifyModelFamily(model);
            if (fam) { modelFamilies.push({ role: 'unet', nodeId, nodeType, model, family: fam }); }
        }
        // CLIP loaders — widget[0] is the model
        if (/CLIPLoader|DualCLIPLoader|CLIPLoaderGGUF/i.test(nodeType) && !/CLIPText|CLIPSet/i.test(nodeType) && widgets.length > 0) {
            const model = String(widgets[0] || '');
            const fam = classifyModelFamily(model);
            if (fam) { modelFamilies.push({ role: 'clip', nodeId, nodeType, model, family: fam }); }
        }
        // VAE loader — widget[0] is the model
        if (/VAELoader/i.test(nodeType) && !/VAEDecode|VAEEncode/i.test(nodeType) && widgets.length > 0) {
            const model = String(widgets[0] || '');
            const fam = classifyModelFamily(model);
            if (fam) { modelFamilies.push({ role: 'vae', nodeId, nodeType, model, family: fam }); }
        }
        // ControlNet loader — widget[0] is the model
        if (/ControlNetLoader/i.test(nodeType) && !/Apply/i.test(nodeType) && widgets.length > 0) {
            const model = String(widgets[0] || '');
            const fam = classifyModelFamily(model);
            if (fam) { modelFamilies.push({ role: 'controlnet', nodeId, nodeType, model, family: fam }); }
        }
    }

    if (modelFamilies.length === 0) { return errors; }

    // Determine the primary family from checkpoint/unet (the "base" model)
    const baseEntry = modelFamilies.find(m => m.role === 'checkpoint' || m.role === 'unet');
    if (!baseEntry) { return errors; }

    const baseFamily = baseEntry.family;

    if (requestedFamily && requestedFamily !== baseFamily) {
        errors.push(`MODEL FAMILY MISMATCH: User requested ${requestedFamily} but workflow base model is ${baseFamily} ("${baseEntry.model}"). Use a ${requestedFamily}-family base model/checkpoint.`);
    }

    // Check CLIP compatibility
    const clipCompat = CLIP_COMPATIBILITY[baseFamily] || [baseFamily];
    for (const m of modelFamilies.filter(m => m.role === 'clip')) {
        if (!clipCompat.includes(m.family)) {
            errors.push(`MODEL FAMILY MISMATCH: Node #${m.nodeId} (${m.nodeType}) uses ${m.family} clip "${m.model}" but the base model is ${baseFamily} ("${baseEntry.model}"). Use a ${baseFamily}-compatible CLIP model or use CheckpointLoaderSimple which includes CLIP.`);
        }
    }

    // Check VAE compatibility
    const vaeCompat = VAE_COMPATIBILITY[baseFamily] || [baseFamily];
    for (const m of modelFamilies.filter(m => m.role === 'vae')) {
        if (!vaeCompat.includes(m.family)) {
            errors.push(`MODEL FAMILY MISMATCH: Node #${m.nodeId} (${m.nodeType}) uses ${m.family} VAE "${m.model}" but the base model is ${baseFamily} ("${baseEntry.model}"). Use a ${baseFamily}-compatible VAE.`);
        }
    }

    // Check ControlNet compatibility
    const cnCompat = CONTROLNET_COMPATIBILITY[baseFamily] || [baseFamily];
    for (const m of modelFamilies.filter(m => m.role === 'controlnet')) {
        if (!cnCompat.includes(m.family)) {
            errors.push(`MODEL FAMILY MISMATCH: Node #${m.nodeId} (${m.nodeType}) uses ${m.family} ControlNet "${m.model}" but the base model is ${baseFamily} ("${baseEntry.model}"). Use a ${baseFamily}-compatible ControlNet.`);
        }
    }

    // Check if user asked for SDXL but agent used a unet loader instead of checkpoint
    if (baseFamily !== 'SDXL') {
        const hasSDXLPart = modelFamilies.some(m => m.family === 'SDXL' && (m.role === 'controlnet' || m.role === 'vae'));
        if (hasSDXLPart) {
            errors.push(`MODEL FAMILY MISMATCH: Workflow mixes ${baseFamily} base model with SDXL components. If SDXL is intended, use an SDXL checkpoint (e.g. "SDXL\\sd_xl_base_1.0.safetensors" via CheckpointLoaderSimple). If ${baseFamily} is intended, use ${baseFamily}-compatible ControlNet/VAE.`);
        }
    }

    return errors;
}

function inferRequestedModelFamily(userMessage: string): string | null {
    const msg = String(userMessage || '');
    if (!msg) { return null; }

    const FAMILY_PATTERNS: { family: string; pattern: RegExp }[] = [
        { family: 'SDXL', pattern: /\bsd\s*[_\-]?xl\b|\bsdxl\b/i },
        { family: 'SD15', pattern: /\bsd\s*1\.?5\b|\bsd15\b|\bv1[-_ ]?5\b/i },
        { family: 'SD3', pattern: /\bsd\s*3\.?5?\b|\bsd3\b/i },
        { family: 'FLUX2', pattern: /\bflux[\s._-]?2\b/i },
        { family: 'FLUX1', pattern: /\bflux\b/i },
        { family: 'QWEN', pattern: /\bqwen\b/i },
        { family: 'HUNYUAN', pattern: /\bhunyuan\b/i },
        { family: 'Z-IMAGE', pattern: /\bz[\-_ ]?image\b/i },
        { family: 'WAN', pattern: /\bwan\b/i },
        { family: 'CHROMA', pattern: /\bchroma\b/i },
        { family: 'OMNIGEN2', pattern: /\bomnigen\s*2?\b/i },
    ];

    for (const f of FAMILY_PATTERNS) {
        if (f.pattern.test(msg)) {
            return f.family;
        }
    }
    return null;
}

/**
 * Infer the model family from the current workflow graph by inspecting
 * UNet / Checkpoint loader widget values. Used as a fallback when the
 * user's message (e.g. "make it a 4 step") doesn't mention a family name.
 */
function inferFamilyFromGraph(graph: Record<string, unknown>): string | null {
    const nodes = Array.isArray(graph.nodes) ? graph.nodes : [];
    const MODEL_LOADER_TYPES = new Set([
        'CheckpointLoaderSimple', 'CheckpointLoader',
        'UNETLoader', 'UnetLoaderGGUF', 'UnetLoaderGGUFAdvanced',
    ]);

    for (const node of nodes) {
        const n = node as Record<string, unknown>;
        if (!MODEL_LOADER_TYPES.has(String(n.type || ''))) { continue; }
        const widgets = Array.isArray(n.widgets_values) ? n.widgets_values : [];
        const modelName = typeof widgets[0] === 'string' ? widgets[0] : '';
        if (!modelName) { continue; }

        // Z-IMAGE must be checked before QWEN — Z-Image models contain
        // "qwen" in their clip path but are a separate family.
        if (/z[_\- ]?image|zimage|heretic/i.test(modelName)) { return 'Z-IMAGE'; }
        if (/qwen/i.test(modelName)) { return 'QWEN'; }
        if (/flux[_\-]?2|flux\.?2/i.test(modelName)) { return 'FLUX2'; }
        if (/flux/i.test(modelName)) { return 'FLUX1'; }
        if (/sdxl|sd[_\- ]?xl/i.test(modelName)) { return 'SDXL'; }
        if (/sd[_\- ]?1\.?5|v1[_\- ]?5/i.test(modelName)) { return 'SD15'; }
        if (/hunyuan/i.test(modelName)) { return 'HUNYUAN'; }
        if (/wan/i.test(modelName)) { return 'WAN'; }
    }
    return null;
}



function validateModelAvailability(
    workflow: Record<string, unknown>,
    availableModels: Record<string, string[]> | undefined,
): string[] {
    const errors: string[] = [];
    if (!availableModels || typeof availableModels !== 'object') {
        return errors;
    }

    const REQUIREMENTS: Record<string, { categories: string[]; widgetIndexes: number[] }> = {
        CheckpointLoaderSimple: { categories: ['checkpoints'], widgetIndexes: [0] },
        CheckpointLoader: { categories: ['checkpoints'], widgetIndexes: [0] },
        UNETLoader: { categories: ['unet', 'unet_gguf', 'diffusion_models', 'checkpoints'], widgetIndexes: [0] },
        UnetLoaderGGUFAdvanced: { categories: ['unet', 'unet_gguf', 'diffusion_models', 'checkpoints'], widgetIndexes: [0] },
        UnetLoaderGGUF: { categories: ['unet', 'unet_gguf', 'diffusion_models', 'checkpoints'], widgetIndexes: [0] },
        CLIPLoader: { categories: ['clip', 'clip_gguf', 'text_encoders'], widgetIndexes: [0] },
        CLIPLoaderGGUF: { categories: ['clip', 'clip_gguf', 'text_encoders'], widgetIndexes: [0] },
        DualCLIPLoader: { categories: ['clip', 'clip_gguf', 'text_encoders'], widgetIndexes: [0, 1] },
        DualCLIPLoaderGGUF: { categories: ['clip', 'clip_gguf', 'text_encoders'], widgetIndexes: [0, 1] },
        TripleCLIPLoader: { categories: ['clip', 'clip_gguf', 'text_encoders'], widgetIndexes: [0, 1, 2] },
        VAELoader: { categories: ['vae'], widgetIndexes: [0] },
        ControlNetLoader: { categories: ['controlnet'], widgetIndexes: [0] },
        LoraLoader: { categories: ['loras'], widgetIndexes: [0] },
        LoraLoaderModelOnly: { categories: ['loras'], widgetIndexes: [0] },
    };

    const nodes = Array.isArray(workflow.nodes) ? workflow.nodes as any[] : [];
    for (const node of nodes) {
        const nodeType = String(node.type || '');
        const req = REQUIREMENTS[nodeType];
        if (!req || !Array.isArray(node.widgets_values)) { continue; }

        const candidates = req.categories
            .flatMap((c) => Array.isArray(availableModels[c]) ? availableModels[c] : [])
            .filter((v, i, arr) => arr.indexOf(v) === i);

        // Path normalization helper for slash-direction comparison
        const _bs = String.fromCharCode(92);
        const norm = (p: string) => p.split(_bs).join('/');

        for (const widgetIndex of req.widgetIndexes) {
            if (widgetIndex >= node.widgets_values.length) { continue; }
            const requested = String(node.widgets_values[widgetIndex] || '').trim();
            if (!requested) { continue; }

            // Check exact match including path normalization (backslash vs forward slash)
            const normalizedReq = norm(requested);
            if (candidates.some(c => c === requested || norm(c) === normalizedReq)) { continue; }

            const widgetName = widgetIndex === 0
                ? (nodeType.includes('CLIP') ? 'clip_name' : nodeType.includes('VAE') ? 'vae_name' : nodeType.includes('ControlNet') ? 'control_net_name' : nodeType.includes('Lora') ? 'lora_name' : nodeType.includes('UNET') || nodeType.includes('Unet') ? 'unet_name' : 'model_name')
                : `widget_${widgetIndex}`;
            errors.push(
                `MODEL NOT FOUND: Node #${node.id} (${nodeType}) widget "${widgetName}" requested "${requested}" but it is not installed in [${req.categories.join(', ')}]. Download: ${googleSearchLink(requested)}`,
            );
        }
    }

    return errors;
}

function extractMissingModelEntriesFromErrors(
    errors: string[],
    familyMissingDetails?: Array<{
        component: string;
        known_files: string[];
        download_url: string;
        download_note: string;
    }>,
): Array<{
    node_id: number;
    node_type: string;
    widget_name: string;
    model: string;
    download: string;
    registry_url: string;
    registry_note: string;
}> {
    // Build a lookup from known_files → registry download info
    const registryLookup = new Map<string, { url: string; note: string }>();
    if (familyMissingDetails) {
        for (const detail of familyMissingDetails) {
            if (detail.download_url && detail.known_files) {
                for (const kf of detail.known_files) {
                    const basename = kf.replace(/^.*[\\/]/, '');
                    registryLookup.set(basename.toLowerCase(), {
                        url: detail.download_url,
                        note: detail.download_note || '',
                    });
                }
                // Also register by component name for broader matching
                registryLookup.set(detail.component.toLowerCase(), {
                    url: detail.download_url,
                    note: detail.download_note || '',
                });
            }
        }
    }

    const entries: Array<{
        node_id: number;
        node_type: string;
        widget_name: string;
        model: string;
        download: string;
        registry_url: string;
        registry_note: string;
    }> = [];

    for (const err of errors) {
        const text = String(err || '');
        const match = text.match(/^MODEL NOT FOUND:\s*Node\s+#(\d+)\s+\(([^)]+)\)\s+widget\s+"([^"]+)"\s+requested\s+"([^"]+)"/i);
        if (!match) { continue; }
        const model = String(match[4] || '').trim();
        const basename = model.replace(/^.*[\\/]/, '').toLowerCase();

        // Try to match against registry known files
        const registryMatch = registryLookup.get(basename);

        entries.push({
            node_id: Number(match[1]),
            node_type: String(match[2] || '').trim(),
            widget_name: String(match[3] || '').trim(),
            model,
            download: googleSearchLink(model),
            registry_url: registryMatch?.url || '',
            registry_note: registryMatch?.note || '',
        });
    }

    // If no models matched directly but we have family-level missing details,
    // append those as synthetic entries so the panel can show download links
    if (entries.length === 0 && familyMissingDetails && familyMissingDetails.length > 0) {
        for (const detail of familyMissingDetails) {
            const knownFile = (detail.known_files && detail.known_files[0]) || detail.component;
            entries.push({
                node_id: 0,
                node_type: 'FamilyRequirement',
                widget_name: detail.component,
                model: knownFile,
                download: googleSearchLink(knownFile),
                registry_url: detail.download_url || '',
                registry_note: detail.download_note || '',
            });
        }
    }

    return entries;
}

/**
 * Validate workflow link integrity AND connection type correctness.
 * Checks that all links reference existing nodes, valid slot indices,
 * and that data types match between source outputs and target inputs.
 * Returns an array of error strings (empty = valid).
 */
function validateWorkflowLinks(workflow: Record<string, unknown>): string[] {
    const errors: string[] = [];
    const nodes = Array.isArray(workflow.nodes) ? workflow.nodes : [];
    const links = Array.isArray(workflow.links) ? workflow.links : [];

    // Build lookup maps
    const nodeById = new Map<number, Record<string, unknown>>();
    for (const node of nodes) {
        if (node && typeof node === 'object' && typeof (node as Record<string, unknown>).id === 'number') {
            nodeById.set((node as Record<string, unknown>).id as number, node as Record<string, unknown>);
        }
    }

    const linkIdSet = new Set<number>();
    for (const link of links) {
        if (!Array.isArray(link) || link.length < 6) {
            errors.push(`Malformed link (expected [id, src_node, src_slot, dst_node, dst_slot, type]): ${JSON.stringify(link)}`);
            continue;
        }
        const [linkId, srcNodeId, srcSlot, dstNodeId, dstSlot] = link;
        linkIdSet.add(linkId);

        // Check source node exists
        if (!nodeById.has(srcNodeId)) {
            errors.push(`Link ${linkId}: source node ${srcNodeId} does not exist`);
        } else {
            // Check source output slot is in bounds
            const srcNode = nodeById.get(srcNodeId)!;
            const outputs = Array.isArray(srcNode.outputs) ? srcNode.outputs : [];
            if (srcSlot < 0 || srcSlot >= outputs.length) {
                errors.push(`Link ${linkId}: source output slot ${srcSlot} out of bounds for node ${srcNodeId} (${(srcNode.type as string) || 'unknown'}, has ${outputs.length} outputs)`);
            }
        }

        // Check target node exists
        if (!nodeById.has(dstNodeId)) {
            errors.push(`Link ${linkId}: target node ${dstNodeId} does not exist`);
        } else {
            // Check target input slot is in bounds
            const dstNode = nodeById.get(dstNodeId)!;
            const inputs = Array.isArray(dstNode.inputs) ? dstNode.inputs : [];
            if (dstSlot < 0 || dstSlot >= inputs.length) {
                errors.push(`Link ${linkId}: target input slot ${dstSlot} out of bounds for node ${dstNodeId} (${(dstNode.type as string) || 'unknown'}, has ${inputs.length} inputs)`);
            }
        }

        // ── TYPE VALIDATION — Check the data type in the link matches the node specs ──
        const linkType = typeof link[5] === 'string' ? link[5] : '';
        if (linkType && nodeById.has(srcNodeId) && nodeById.has(dstNodeId)) {
            const srcNode = nodeById.get(srcNodeId)!;
            const dstNode = nodeById.get(dstNodeId)!;
            const srcType = String(srcNode.type || '');
            const dstType = String(dstNode.type || '');
            const srcSpec = NODE_WIRING_SPEC[srcType];
            const dstSpec = NODE_WIRING_SPEC[dstType];

            // Check source output type matches the link type
            if (srcSpec && srcSlot >= 0 && srcSlot < srcSpec.outputs.length) {
                const expectedSrcType = srcSpec.outputs[srcSlot].type;
                if (expectedSrcType !== linkType && linkType !== '*') {
                    errors.push(`Link ${linkId}: TYPE MISMATCH at source — node #${srcNodeId} (${srcType}) output slot ${srcSlot} produces ${expectedSrcType} but link says ${linkType}`);
                }
            }

            // Check target input type matches the link type
            if (dstSpec) {
                // Loader nodes should NEVER receive incoming links
                if (dstSpec.inputs.length === 0) {
                    errors.push(`Link ${linkId}: INVALID TARGET — node #${dstNodeId} (${dstType}) has NO connectable inputs (it's a loader with only widget inputs). Do not send ${linkType} to it.`);
                } else if (dstSlot >= 0 && dstSlot < dstSpec.inputs.length) {
                    const expectedDstType = dstSpec.inputs[dstSlot].type;
                    const expectedDstName = dstSpec.inputs[dstSlot].name;
                    if (expectedDstType !== linkType && linkType !== '*') {
                        errors.push(`Link ${linkId}: TYPE MISMATCH at target — node #${dstNodeId} (${dstType}) input "${expectedDstName}" (slot ${dstSlot}) expects ${expectedDstType} but receives ${linkType}. Check the CONTROLNET WIRING PATTERN in your instructions.`);
                    }
                }
            }
        }
    }

    // ── Check required inputs for known node types are connected ──
    for (const node of nodes) {
        const n = node as Record<string, unknown>;
        const nodeId = n.id as number;
        const nodeType = String(n.type || '');
        const spec = NODE_WIRING_SPEC[nodeType];
        if (!spec || spec.inputs.length === 0) { continue; }

        const nodeInputs = Array.isArray(n.inputs) ? n.inputs as Record<string, unknown>[] : [];
        for (let i = 0; i < spec.inputs.length; i++) {
            const expectedInput = spec.inputs[i];
            // Find the input at this slot index
            if (i < nodeInputs.length) {
                const inp = nodeInputs[i];
                if (inp.link === null || inp.link === undefined) {
                    errors.push(`Node #${nodeId} (${nodeType}): required input "${expectedInput.name}" (${expectedInput.type}) at slot ${i} is DISCONNECTED — it must be connected`);
                }
            } else {
                errors.push(`Node #${nodeId} (${nodeType}): missing input slot ${i} for "${expectedInput.name}" (${expectedInput.type})`);
            }
        }
    }

    // Check that every link ID referenced in node inputs/outputs exists in the links array
    for (const node of nodes) {
        const n = node as Record<string, unknown>;
        const nodeId = n.id as number;
        const inputs = Array.isArray(n.inputs) ? n.inputs : [];
        for (const inp of inputs) {
            const input = inp as Record<string, unknown>;
            if (input.link !== null && input.link !== undefined && typeof input.link === 'number') {
                if (!linkIdSet.has(input.link)) {
                    errors.push(`Node ${nodeId} (${(n.type as string) || 'unknown'}): input "${input.name}" references link ${input.link} which does not exist in the links array`);
                }
            }
        }
        const outputs = Array.isArray(n.outputs) ? n.outputs : [];
        for (const out of outputs) {
            const output = out as Record<string, unknown>;
            if (Array.isArray(output.links)) {
                for (const lid of output.links) {
                    if (typeof lid === 'number' && !linkIdSet.has(lid)) {
                        errors.push(`Node ${nodeId} (${(n.type as string) || 'unknown'}): output "${output.name}" references link ${lid} which does not exist in the links array`);
                    }
                }
            }
        }
    }

    return errors;
}

/**
 * Extract a ComfyUI workflow JSON from an LLM response.
 * Looks for ```json ... ``` code blocks containing valid workflow objects.
 */
function stripJsonComments(json: string): string {
    // Strip // line comments and /* block comments */ while preserving strings
    return json
        .replace(/("(?:[^"\\]|\\.)*")|(\/\/[^\n]*)/g, (m, str) => str || '')
        .replace(/("(?:[^"\\]|\\.)*")|(\/\*[\s\S]*?\*\/)/g, (m, str) => str || '');
}

function extractWorkflowJson(text: string): Record<string, unknown> | null {
    // Try to find ```json ... ``` blocks
    const jsonBlockRegex = /```json\s*\n([\s\S]*?)```/g;
    let match;
    while ((match = jsonBlockRegex.exec(text)) !== null) {
        try {
            const cleaned = stripJsonComments(match[1]);
            const parsed = JSON.parse(cleaned);
            if (typeof parsed === 'object' && parsed !== null) {
                // Validate it looks like a ComfyUI workflow
                if (Array.isArray(parsed.nodes) && parsed.nodes.length > 0) {
                    return parsed as Record<string, unknown>;
                }
                // Check if it's wrapped in a workflow key
                if (parsed.workflow && Array.isArray(parsed.workflow.nodes)) {
                    return parsed.workflow as Record<string, unknown>;
                }
            }
        } catch {
            // Invalid JSON in this block, try next
        }
    }

    // Fallback: try to find any large JSON object with "nodes" array
    const braceRegex = /\{[\s\S]*"nodes"\s*:\s*\[[\s\S]*\][\s\S]*\}/;
    const braceMatch = braceRegex.exec(text);
    if (braceMatch) {
        try {
            const cleaned = stripJsonComments(braceMatch[0]);
            const parsed = JSON.parse(cleaned);
            if (typeof parsed === 'object' && Array.isArray(parsed.nodes) && parsed.nodes.length > 0) {
                return parsed as Record<string, unknown>;
            }
        } catch {
            // Not valid JSON
        }
    }

    return null;
}

// ── Log Rotation Utilities ──────────────────────────────────────────

function rotateLog(filePath: string, backups: number): void {
    try {
        // Shift existing backups: .log.5 -> deleted, .log.4 -> .log.5
        for (let i = backups - 1; i >= 1; i--) {
            const oldFile = `${filePath}.${i}`;
            const newFile = `${filePath}.${i + 1}`;
            if (fs.existsSync(oldFile)) {
                try { fs.renameSync(oldFile, newFile); } catch { /* best effort */ }
            }
        }
        // Rename current log to .log.1
        const backupOne = `${filePath}.1`;
        if (fs.existsSync(filePath)) {
            try { fs.renameSync(filePath, backupOne); } catch { /* best effort */ }
        }
    } catch (err) {
        console.error('Log rotation failed:', err);
    }
}

function cleanupOldLogs(dirPath: string, days: number): void {
    if (!fs.existsSync(dirPath)) { return; }
    const now = Date.now();
    const maxAge = days * 24 * 60 * 60 * 1000;

    try {
        const files = fs.readdirSync(dirPath);
        for (const file of files) {
            // Match .log files (and rotated ones)
            if (file.includes('.log')) {
                const fp = path.join(dirPath, file);
                try {
                    const stats = fs.statSync(fp);
                    if (now - stats.mtimeMs > maxAge) {
                        fs.unlinkSync(fp);
                    }
                } catch { /* ignore locked files */ }
            }
        }
    } catch { /* directory access error */ }
}
