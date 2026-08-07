'use strict';

const path = require('path');

function resolveExpertInstance(entryFilename) {
  const entrypoint = path.basename(String(entryFilename || 'server.js'));
  const adaptiveProtection = entrypoint === 'server-3014.js';
  const port = adaptiveProtection ? 3014 : 3013;
  return {
    host: '127.0.0.1',
    port,
    dataDirectoryName: adaptiveProtection ? 'data-3014' : 'data',
    endpoint: `http://127.0.0.1:${port}`,
    adaptiveProtection,
  };
}

module.exports = { resolveExpertInstance };
