'use strict';

const { parentPort, workerData } = require('worker_threads');
const backtest = require('./backtest');

if (!parentPort) throw new Error('backtest-worker must run in a worker thread');

backtest.run({
  ...workerData,
  onProgress: (progress) => parentPort.postMessage({ type: 'progress', progress }),
}).then((result) => {
  parentPort.postMessage({ type: 'result', result });
}).catch((error) => {
  parentPort.postMessage({ type: 'error', error: { message: error.message, stack: error.stack } });
});
