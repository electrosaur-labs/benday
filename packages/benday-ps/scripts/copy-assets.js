#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const distDir = path.join(__dirname, '..', 'dist');
const srcDir = path.join(__dirname, '..', 'src');

if (!fs.existsSync(distDir)) {
  fs.mkdirSync(distDir, { recursive: true });
}

// Copy manifest.json -> dist/manifest.json
const manifestSrc = path.join(__dirname, '..', 'manifest.json');
const manifestDst = path.join(distDir, 'manifest.json');
if (fs.existsSync(manifestSrc)) {
  const manifest = JSON.parse(fs.readFileSync(manifestSrc, 'utf8'));
  manifest.main = 'index.html';
  fs.writeFileSync(manifestDst, JSON.stringify(manifest, null, 2) + '\n');
  console.log('✓ Copied manifest.json');
}

// Copy src/styles.css -> dist/styles.css AND inline <style> into dist/index.html
// so Adobe UXP Developer Tool Reload never serves a stale cached external stylesheet.
const cssSrc = path.join(srcDir, 'styles.css');
const cssDst = path.join(distDir, 'styles.css');
let cssText = '';
if (fs.existsSync(cssSrc)) {
  cssText = fs.readFileSync(cssSrc, 'utf8');
  fs.writeFileSync(cssDst, cssText);
  console.log('✓ Copied styles.css');
}

// Copy src/index.html -> dist/index.html (with inline <style> matching Reveal)
const htmlSrc = path.join(srcDir, 'index.html');
const htmlDst = path.join(distDir, 'index.html');
if (fs.existsSync(htmlSrc)) {
  let htmlText = fs.readFileSync(htmlSrc, 'utf8');
  if (cssText) {
    htmlText = htmlText.replace(
      /<link\s+rel="stylesheet"\s+href="styles\.css"\s*\/?>/,
      `<style>\n${cssText}\n</style>`
    );
  }
  fs.writeFileSync(htmlDst, htmlText);
  console.log('✓ Built index.html (inlined styles.css)');
}

// Copy src/assets/* -> dist/assets/*
const assetsSrcDir = path.join(srcDir, 'assets');
const assetsDstDir = path.join(distDir, 'assets');
if (fs.existsSync(assetsSrcDir)) {
  if (!fs.existsSync(assetsDstDir)) {
    fs.mkdirSync(assetsDstDir, { recursive: true });
  }
  for (const file of fs.readdirSync(assetsSrcDir)) {
    fs.copyFileSync(path.join(assetsSrcDir, file), path.join(assetsDstDir, file));
  }
  console.log('✓ Copied assets/');
}

console.log('Benday asset copying complete!');
