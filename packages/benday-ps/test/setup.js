'use strict';

const Module = require('module');
const path = require('path');

const originalResolveFilename = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (request === 'photoshop') {
    return path.resolve(__dirname, 'mocks/photoshop.js');
  }
  if (request === 'uxp') {
    return path.resolve(__dirname, 'mocks/uxp.js');
  }
  return originalResolveFilename.call(this, request, ...rest);
};
