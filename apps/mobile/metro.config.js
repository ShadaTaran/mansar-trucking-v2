const path = require('path');
const { getDefaultConfig, mergeConfig } = require('@react-native/metro-config');

/**
 * Metro configuration
 * https://reactnative.dev/docs/metro
 *
 * Deviation from the stock template: this app lives in an npm workspace.
 * Workspace packages such as `@mansar/types` are symlinked from the
 * monorepo root, so the root must be watched for Metro to serve their files.
 * Module resolution itself is unchanged (hierarchical lookup already finds the
 * root-hoisted `node_modules`).
 *
 * @type {import('@react-native/metro-config').MetroConfig}
 */
const workspaceRoot = path.resolve(__dirname, '../..');

const config = {
  watchFolders: [workspaceRoot],
};

module.exports = mergeConfig(getDefaultConfig(__dirname), config);
