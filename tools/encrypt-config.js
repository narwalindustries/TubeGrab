#!/usr/bin/env node

/**
 * TubeGrab Binary Bitwise Config Encryptor
 * Encrypts your Backend URL & API Secret Key into raw binary bitstreams
 * so they are never visible as plain text in the published frontend.
 */

const fs = require('fs');
const path = require('path');

const BIT_KEY = 'TubeGrab_SecureBitMask_2026';

function encodeToBits(text, mask = BIT_KEY) {
  let bits = '';
  for (let i = 0; i < text.length; i++) {
    const byteVal = (text.charCodeAt(i) ^ mask.charCodeAt(i % mask.length)) & 0xFF;
    bits += byteVal.toString(2).padStart(8, '0');
  }
  return bits;
}

// Read from .env if available
let backendUrl = process.env.BACKEND_URL || '';
let apiKey = process.env.API_SECRET_KEY || '';

const envPath = path.join(__dirname, '..', '.env');
if (fs.existsSync(envPath)) {
  const content = fs.readFileSync(envPath, 'utf8');
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const [k, ...v] = trimmed.split('=');
    const key = k.trim();
    const val = v.join('=').trim().replace(/^['"]|['"]$/g, '');
    if (key === 'BACKEND_URL' && !backendUrl) backendUrl = val;
    if (key === 'API_SECRET_KEY' && !apiKey) apiKey = val;
  }
}

// Fallback to args if provided: node tools/encrypt-config.js <URL> <KEY>
if (process.argv[2]) backendUrl = process.argv[2];
if (process.argv[3]) apiKey = process.argv[3];

if (!backendUrl && !apiKey) {
  console.log('Usage: node tools/encrypt-config.js [BACKEND_URL] [API_SECRET_KEY]');
  console.log('Or add BACKEND_URL and API_SECRET_KEY in your local .env file.');
  process.exit(1);
}

const urlBits = backendUrl ? encodeToBits(backendUrl) : '';
const keyBits = apiKey ? encodeToBits(apiKey) : '';

const outputConfig = `// Auto-generated encrypted binary configuration
// Safe to publish on Firebase or embed in Android APK
window.__ENCRYPTED_CONFIG__ = {
  urlBits: "${urlBits}",
  keyBits: "${keyBits}"
};
`;

const targetPath = path.join(__dirname, '..', 'public', 'config.js');
fs.writeFileSync(targetPath, outputConfig, 'utf8');

console.log('------------------------------------------------------------');
console.log('✓ Encrypted binary config successfully created at public/config.js');
console.log(`✓ Backend URL: ${backendUrl ? '[Encrypted into ' + urlBits.length + ' bits]' : 'None'}`);
console.log(`✓ API Key:     ${apiKey ? '[Encrypted into ' + keyBits.length + ' bits]' : 'None'}`);
console.log('------------------------------------------------------------');
