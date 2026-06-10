#!/usr/bin/env node

/**
 * Nebula MCP Setup Script
 *
 * Automatically configures Nebula MCP server for detected AI tools:
 * - Claude Code
 * - Claude Desktop
 * - Cursor IDE
 * - Gemini CLI
 * - Codex CLI (OpenAI)
 * - VS Code / GitHub Copilot (workspace)
 * - Antigravity
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';
import readline from 'readline';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Get absolute path to nebula-mcp.js
const MCP_SERVER_PATH = path.join(__dirname, 'bin', 'nebula-mcp.js');

// Config file locations
const CONFIG_PATHS = {
  claudeCode: path.join(process.env.HOME, '.claude.json'),
  claudeDesktop: path.join(process.env.HOME, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json'),
  cursor: path.join(process.env.HOME, '.cursor', 'mcp.json'),
  gemini: path.join(process.env.HOME, '.gemini', 'settings.json'),
  codex: path.join(process.env.HOME, '.codex', 'config.toml'),
  vscodeWorkspace: path.join(process.cwd(), '.vscode', 'mcp.json'),
  antigravity: path.join(process.env.HOME, '.gemini', 'antigravity', 'mcp_config.json'),
};

// When running from an npm install (node_modules, including the npx cache),
// write configs that invoke `npx -y nebula-tools` — stable across npx cache
// evictions and package updates. A repo checkout keeps the absolute path
// (works offline and tracks local edits).
const IS_NPM_INSTALL = __dirname.split(path.sep).includes('node_modules');
const MCP_COMMAND = IS_NPM_INSTALL ? 'npx' : 'node';
const MCP_ARGS = IS_NPM_INSTALL ? ['-y', 'nebula-tools'] : [MCP_SERVER_PATH];

// Nebula MCP server configuration
const NEBULA_MCP_CONFIG = {
  command: MCP_COMMAND,
  args: MCP_ARGS,
};

const NEBULA_MCP_VSCODE_CONFIG = {
  type: 'stdio',
  command: MCP_COMMAND,
  args: MCP_ARGS,
};

// Helper to check if command exists
function commandExists(command) {
  try {
    execSync(`which ${command}`, { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

// Helper to read JSON file
function readJSON(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

// Helper to write JSON file
function writeJSON(filePath, data) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + '\n');
}

// Helper to backup file
function backupFile(filePath) {
  if (fs.existsSync(filePath)) {
    const backupPath = `${filePath}.backup-${Date.now()}`;
    fs.copyFileSync(filePath, backupPath);
    return backupPath;
  }
  return null;
}

function isPlainObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value);
}

function sortKeys(value) {
  if (Array.isArray(value)) {
    return value.map(sortKeys);
  }
  if (!isPlainObject(value)) {
    return value;
  }
  return Object.keys(value)
    .sort()
    .reduce((acc, key) => {
      acc[key] = sortKeys(value[key]);
      return acc;
    }, {});
}

function stableStringify(value) {
  return JSON.stringify(sortKeys(value));
}

function deepEqual(a, b) {
  return stableStringify(a) === stableStringify(b);
}

function mergeServerConfig(existing, desired) {
  if (!isPlainObject(existing)) {
    return desired;
  }
  const merged = { ...existing, ...desired };
  if (isPlainObject(existing.env) || isPlainObject(desired.env)) {
    merged.env = {
      ...(isPlainObject(existing.env) ? existing.env : {}),
      ...(isPlainObject(desired.env) ? desired.env : {}),
    };
  }
  // We intentionally do NOT rely on a default server URL via env.
  // Remove legacy NEBULA_URL to avoid accidental connections to the wrong instance.
  if (isPlainObject(merged.env)) {
    delete merged.env.NEBULA_URL;
    if (Object.keys(merged.env).length === 0) {
      delete merged.env;
    }
  }
  return merged;
}

function upsertMcpServer(config, rootKey, serverName, desiredConfig) {
  if (!isPlainObject(config[rootKey])) {
    config[rootKey] = {};
  }
  const existing = config[rootKey][serverName];
  const next = mergeServerConfig(existing, desiredConfig);
  if (deepEqual(existing, next)) {
    return false;
  }
  config[rootKey][serverName] = next;
  return true;
}

// Detect installed AI tools
function detectTools() {
  const tools = {};
  const hasVSCodeCli = commandExists('code') || commandExists('code-insiders');
  const hasAntigravityCli = commandExists('antigravity') || commandExists('agy');
  const hasVSCodeWorkspace = fs.existsSync(path.join(process.cwd(), '.vscode'));

  // Claude Code
  if (commandExists('claude')) {
    tools.claudeCode = { name: 'Claude Code', configPath: CONFIG_PATHS.claudeCode };
  }

  // Claude Desktop
  if (fs.existsSync(path.dirname(CONFIG_PATHS.claudeDesktop))) {
    tools.claudeDesktop = { name: 'Claude Desktop', configPath: CONFIG_PATHS.claudeDesktop };
  }

  // Cursor
  if (commandExists('cursor') || fs.existsSync(path.join(process.env.HOME, '.cursor'))) {
    tools.cursor = { name: 'Cursor IDE', configPath: CONFIG_PATHS.cursor };
  }

  // Gemini CLI
  if (commandExists('gemini')) {
    tools.gemini = { name: 'Gemini CLI', configPath: CONFIG_PATHS.gemini };
  }

  // Codex CLI
  if (commandExists('codex')) {
    tools.codex = { name: 'Codex CLI', configPath: CONFIG_PATHS.codex };
  }

  // VS Code / GitHub Copilot / Antigravity workspace config
  if (hasVSCodeCli || hasAntigravityCli || hasVSCodeWorkspace) {
    tools.vscodeWorkspace = {
      name: 'VS Code / GitHub Copilot / Antigravity (workspace)',
      configPath: CONFIG_PATHS.vscodeWorkspace
    };
  }

  // Antigravity global config (if available)
  if (
    hasAntigravityCli ||
    fs.existsSync(CONFIG_PATHS.antigravity) ||
    fs.existsSync(path.dirname(CONFIG_PATHS.antigravity))
  ) {
    tools.antigravity = {
      name: 'Antigravity (global)',
      configPath: CONFIG_PATHS.antigravity
    };
  }

  return tools;
}

function configureJsonServer(configPath, rootKey, serverConfig, options = {}) {
  const config = readJSON(configPath) || {};
  const changed = upsertMcpServer(config, rootKey, 'nebula-notebook', serverConfig);

  if (options.dryRun) {
    return { changed };
  }
  if (!changed) {
    return { changed: false };
  }

  writeJSON(configPath, config);
  return { changed: true };
}

function buildCodexBlock() {
  return [
    '[mcp_servers.nebula-notebook]',
    `command = "${MCP_COMMAND}"`,
    `args = [${MCP_ARGS.map((a) => `"${a}"`).join(', ')}]`,
  ].join('\n');
}

function normalizeToml(value) {
  return value.trim().replace(/\s+/g, ' ');
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function extractCodexBlock(content) {
  const baseMatch = content.match(/\[mcp_servers\.nebula-notebook\][\s\S]*?(?=\n\[|$)/);
  const parts = [];
  if (baseMatch) {
    parts.push(baseMatch[0].trim());
  }
  return parts.join('\n\n').trim();
}

function codexHasRequiredConfig(content) {
  const baseMatch = content.match(/\[mcp_servers\.nebula-notebook\][\s\S]*?(?=\n\[|$)/);
  if (!baseMatch) {
    return false;
  }

  const baseBlock = baseMatch[0];
  const hasCommand = new RegExp(`command\\s*=\\s*"${escapeRegExp(MCP_COMMAND)}"`).test(baseBlock);
  const expectedArgs = MCP_ARGS.map((a) => `"${escapeRegExp(a)}"`).join('\\s*,\\s*');
  const hasArgs = new RegExp(`args\\s*=\\s*\\[\\s*${expectedArgs}\\s*\\]`).test(baseBlock);
  const envMatch = content.match(/\[mcp_servers\.nebula-notebook\.env\][\s\S]*?(?=\n\[|$)/);
  // If an env block exists, treat as not "clean" since we want to remove legacy NEBULA_URL defaults.
  const hasEnvBlock = !!envMatch;

  return hasCommand && hasArgs && !hasEnvBlock;
}

function stripCodexBlock(content) {
  return content
    .replace(/\[mcp_servers\.nebula-notebook\][\s\S]*?(?=\n\[|$)/g, '')
    .replace(/\[mcp_servers\.nebula-notebook\.env\][\s\S]*?(?=\n\[|$)/g, '');
}

function prepareCodexContent(existingContent) {
  const desiredBlock = buildCodexBlock().trim();
  const baseCount = (existingContent.match(/\[mcp_servers\.nebula-notebook\]/g) || []).length;
  const envCount = (existingContent.match(/\[mcp_servers\.nebula-notebook\.env\]/g) || []).length;
  const existingBlock = extractCodexBlock(existingContent);
  const matchesRequired = codexHasRequiredConfig(existingContent);
  const hasDuplicates = baseCount > 1 || envCount > 1;
  const hasLegacyEnv = envCount > 0;
  const isSame =
    !hasDuplicates &&
    !hasLegacyEnv &&
    (matchesRequired ||
      (existingBlock &&
        normalizeToml(existingBlock) === normalizeToml(desiredBlock) &&
        baseCount <= 1));

  if (isSame) {
    return { changed: false, content: existingContent };
  }

  let baseContent = stripCodexBlock(existingContent).trimEnd();
  if (baseContent.length > 0) {
    baseContent += '\n\n';
  }
  const nextContent = `${baseContent}${desiredBlock}\n`;
  return { changed: true, content: nextContent };
}

// Configure Claude Code
function configureClaudeCode(configPath, options = {}) {
  return configureJsonServer(configPath, 'mcpServers', NEBULA_MCP_CONFIG, options);
}

// Configure Claude Desktop
function configureClaudeDesktop(configPath, options = {}) {
  return configureJsonServer(configPath, 'mcpServers', NEBULA_MCP_CONFIG, options);
}

// Configure Cursor
function configureCursor(configPath, options = {}) {
  return configureJsonServer(configPath, 'mcpServers', NEBULA_MCP_CONFIG, options);
}

// Configure Gemini CLI
function configureGemini(configPath, options = {}) {
  return configureJsonServer(configPath, 'mcpServers', NEBULA_MCP_CONFIG, options);
}

// Configure VS Code / GitHub Copilot workspace config
function configureVSCodeWorkspace(configPath, options = {}) {
  return configureJsonServer(configPath, 'servers', NEBULA_MCP_VSCODE_CONFIG, options);
}

// Configure Antigravity global config
function configureAntigravity(configPath, options = {}) {
  return configureJsonServer(configPath, 'mcpServers', NEBULA_MCP_CONFIG, options);
}

// Configure Codex CLI (TOML format)
function configureCodex(configPath, options = {}) {
  const existingContent = fs.existsSync(configPath) ? fs.readFileSync(configPath, 'utf8') : '';
  const { changed, content } = prepareCodexContent(existingContent);

  if (options.dryRun) {
    return { changed };
  }
  if (!changed) {
    return { changed: false };
  }

  const dir = path.dirname(configPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  fs.writeFileSync(configPath, content);
  return { changed: true };
}

// Prompt user for confirmation
function promptUser(question) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });

  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.toLowerCase() === 'y' || answer.toLowerCase() === 'yes');
    });
  });
}

// Main setup function
async function main() {
  console.log('\n🔍 Detecting installed AI tools...\n');

  const tools = detectTools();
  const toolNames = Object.keys(tools);

  if (toolNames.length === 0) {
    console.log('❌ No supported AI tools detected.');
    console.log('\nSupported tools: Claude Code, Claude Desktop, Cursor, Gemini CLI, Codex CLI, VS Code / GitHub Copilot, Antigravity');
    process.exit(1);
  }

  console.log('Found:');
  toolNames.forEach(key => {
    console.log(`  ✓ ${tools[key].name}`);
  });
  console.log('');

  // Show configuration details
  console.log('📦 Nebula MCP server will be configured at:');
  console.log(`    ${MCP_SERVER_PATH}\n`);

  console.log('⚙️  Configure Nebula MCP for:');
  toolNames.forEach(key => {
    console.log(`    [✓] ${tools[key].name} (${tools[key].configPath})`);
  });
  console.log('');

  // Confirm with user
  const confirmed = await promptUser('Continue? (y/N): ');
  if (!confirmed) {
    console.log('❌ Setup cancelled.');
    process.exit(0);
  }

  const configurators = {
    claudeCode: configureClaudeCode,
    claudeDesktop: configureClaudeDesktop,
    cursor: configureCursor,
    gemini: configureGemini,
    codex: configureCodex,
    vscodeWorkspace: configureVSCodeWorkspace,
    antigravity: configureAntigravity,
  };

  const plan = {};
  toolNames.forEach(key => {
    plan[key] = configurators[key](tools[key].configPath, { dryRun: true });
  });

  console.log('\n💾 Backing up configs...');
  const backups = {};
  toolNames.forEach(key => {
    if (!plan[key]?.changed) {
      return;
    }
    const backup = backupFile(tools[key].configPath);
    if (backup) {
      backups[key] = backup;
      console.log(`✓ Backed up ${path.basename(tools[key].configPath)} → ${path.basename(backup)}`);
    }
  });

  // Configure each tool
  console.log('');
  for (const key of toolNames) {
    try {
      console.log(`⚙️  Configuring ${tools[key].name}...`);
      if (!plan[key]?.changed) {
        console.log(`↷ Already configured in ${path.basename(tools[key].configPath)}`);
        continue;
      }
      configurators[key](tools[key].configPath);
      console.log(`✓ Added/updated nebula-notebook in ${path.basename(tools[key].configPath)}`);
    } catch (error) {
      console.error(`✗ Failed to configure ${tools[key].name}: ${error.message}`);
      if (backups[key]) {
        console.log(`  → Restored from backup: ${backups[key]}`);
        fs.copyFileSync(backups[key], tools[key].configPath);
      }
    }
  }

  console.log('\n✅ Setup complete! Restart your AI tools to use Nebula MCP.');
  console.log('\nVerify with:');
  if (tools.claudeCode) console.log('  - claude mcp list');
  if (tools.cursor) console.log('  - Cursor → Settings → Model Context Protocol');
  if (tools.gemini) console.log('  - gemini mcp list');
  if (tools.codex) console.log('  - codex mcp list');
  if (tools.vscodeWorkspace) console.log('  - VS Code → Settings → Model Context Protocol');
  console.log('');
}

main().catch(error => {
  console.error('❌ Setup failed:', error.message);
  process.exit(1);
});
