#!/usr/bin/env node
'use strict';

/**
 * Package dist/ into benday-v<version>.ccx (ZIP archive for Adobe UXP).
 */
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const rootDir = path.join(__dirname, '..');
const distDir = path.join(rootDir, 'dist');
const pkg = JSON.parse(fs.readFileSync(path.join(rootDir, 'package.json'), 'utf8'));
const outputFile = path.join(rootDir, `benday-v${pkg.version}.ccx`);

if (!fs.existsSync(distDir)) {
  console.error('dist/ directory not found. Run "npm run build" first.');
  process.exit(1);
}

for (const entry of fs.readdirSync(rootDir)) {
  if (/^benday-v.*\.ccx$/.test(entry)) {
    fs.unlinkSync(path.join(rootDir, entry));
  }
}

execSync(`cd "${distDir}" && zip -r "${outputFile}" *`, { stdio: 'inherit' });
const stats = fs.statSync(outputFile);
console.log(`Packaged: ${path.basename(outputFile)} (${(stats.size / 1024).toFixed(1)} KB)`);
