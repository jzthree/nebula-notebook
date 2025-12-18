#!/usr/bin/env node
/**
 * Interactive setup script for Nebula Notebook
 * Prompts for working directory on first run
 */
const fs = require('fs');
const path = require('path');
const readline = require('readline');

const CONFIG_FILE = path.join(__dirname, '.nebula-config.json');

function loadConfig() {
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8'));
    }
  } catch (e) {
    // Ignore
  }
  return null;
}

function saveConfig(config) {
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
}

function prompt(question) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });

  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

function expandPath(p) {
  if (p.startsWith('~')) {
    return path.join(process.env.HOME || process.env.USERPROFILE, p.slice(1));
  }
  return path.resolve(p);
}

async function main() {
  const config = loadConfig();
  const forceSetup = process.argv.includes('--setup');

  console.log('\n🌌 Nebula Notebook Setup\n');

  if (config && !forceSetup) {
    console.log(`Current working directory: ${config.rootDirectory}`);
    const change = await prompt('Keep this directory? [Y/n]: ');

    if (change.toLowerCase() !== 'n') {
      console.log('\n✓ Using existing configuration\n');
      process.exit(0);
    }
  }

  // Get home directory as default
  const homeDir = process.env.HOME || process.env.USERPROFILE || '~';

  const rootDir = await prompt(`Enter root directory for notebooks [${homeDir}]: `);
  const finalDir = rootDir || homeDir;
  const expandedDir = expandPath(finalDir);

  // Validate directory exists
  if (!fs.existsSync(expandedDir)) {
    console.log(`\n⚠ Directory does not exist: ${expandedDir}`);
    const create = await prompt('Create it? [y/N]: ');
    if (create.toLowerCase() === 'y') {
      fs.mkdirSync(expandedDir, { recursive: true });
      console.log(`✓ Created directory: ${expandedDir}`);
    } else {
      console.log('Aborted.');
      process.exit(1);
    }
  }

  saveConfig({ rootDirectory: expandedDir });
  console.log(`\n✓ Configuration saved to ${CONFIG_FILE}`);
  console.log(`  Root directory: ${expandedDir}\n`);
}

main().catch(console.error);
