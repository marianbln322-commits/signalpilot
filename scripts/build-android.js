'use strict';

const path = require('path');
const { spawnSync } = require('child_process');

const repositoryRoot = path.resolve(__dirname, '..');
const androidRoot = path.join(repositoryRoot, 'android');
const wrapper = process.platform === 'win32'
  ? path.join(androidRoot, 'gradlew.bat')
  : path.join(androidRoot, 'gradlew');

const result = spawnSync(wrapper, ['-p', androidRoot, ':app:assembleDebug'], {
  cwd: repositoryRoot,
  stdio: 'inherit',
  shell: process.platform === 'win32',
});

if (result.error) {
  console.error(`Nu am putut porni Gradle wrapper: ${result.error.message}`);
  process.exit(1);
}
process.exit(result.status == null ? 1 : result.status);
