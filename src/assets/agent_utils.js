/**
 * Shared utility functions for Operation Faith.
 * Source of Truth: ES Module format.
 * 
 * deployed by scripts/deploy_sync.py:
 *  - To ComfyUI Frontend: Copied as-is (ES Module).
 *  - To VS Code Extension: Transformed to CommonJS by stripping 'export' and adding module.exports.
 */

function modelSearchToken(modelName) {
    return String(modelName || "")
        .replace(/\\/g, "/")
        .split("/")
        .pop()
        ?.replace(/\.(safetensors|ckpt|pt|pth|bin|gguf)$/i, "")
        ?.trim() || String(modelName || "").trim();
}

function googleSearchLink(modelName) {
    return `https://www.google.com/search?q=${encodeURIComponent('download huggingface ' + modelSearchToken(modelName))}`;
}

module.exports = { modelSearchToken, googleSearchLink };