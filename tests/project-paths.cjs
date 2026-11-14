'use strict';

const { existsSync } = require('node:fs');
const path = require('node:path');

const projectRoot = path.resolve(__dirname, '..');

// Benchmarks also accept a v1.5.76 or older baseline with flat paths.
function projectFile(directory, folder, name) {
  const nested = path.join(directory, folder, name);
  return existsSync(nested) ? nested : path.join(directory, name);
}

module.exports = { projectRoot, projectFile };
