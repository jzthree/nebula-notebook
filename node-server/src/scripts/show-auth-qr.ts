import fs from 'fs';
import os from 'os';
import path from 'path';
import { authenticator } from 'otplib';
import * as qrcode from 'qrcode-terminal';

interface AuthConfigFile {
  totpSecret?: string;
  setupComplete?: boolean;
}

const AUTH_CONFIG_FILE = path.join(os.homedir(), '.nebula', 'auth.json');
const ISSUER = 'NebulaNotebook';
const ACCOUNT_NAME = 'local';

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

function readAuthConfig(): AuthConfigFile {
  if (!fs.existsSync(AUTH_CONFIG_FILE)) {
    fail(`[Auth] Config not found: ${AUTH_CONFIG_FILE}\n[Auth] Start the Nebula server once to initialize 2FA.`);
  }

  try {
    const raw = fs.readFileSync(AUTH_CONFIG_FILE, 'utf-8');
    return JSON.parse(raw) as AuthConfigFile;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    fail(`[Auth] Failed to read ${AUTH_CONFIG_FILE}: ${detail}`);
  }
}

function main(): void {
  const config = readAuthConfig();
  const secret = typeof config.totpSecret === 'string' ? config.totpSecret.trim() : '';

  if (!secret) {
    fail(`[Auth] Missing \"totpSecret\" in ${AUTH_CONFIG_FILE}`);
  }

  const otpAuthUrl = authenticator.keyuri(ACCOUNT_NAME, ISSUER, secret);

  console.log('\n' + '='.repeat(60));
  console.log('  NEBULA NOTEBOOK - 2FA QR');
  console.log('='.repeat(60));
  console.log('\nScan this QR code with your authenticator app:\n');

  qrcode.generate(otpAuthUrl, { small: true });

  console.log('\nOr enter this key manually: ' + secret);
  console.log(`\nConfig: ${AUTH_CONFIG_FILE}`);
  console.log(`[Auth] setupComplete=${config.setupComplete === true ? 'true' : 'false'}`);
  console.log('='.repeat(60) + '\n');
}

main();
