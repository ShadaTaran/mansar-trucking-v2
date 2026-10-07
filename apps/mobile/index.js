/**
 * @format
 */

import { AppRegistry } from 'react-native';
import App from './App';
import { name as appName } from './app.json';
import {
  LOCATION_DRAIN_TASK_NAME,
  runBackgroundDrain,
} from './src/location/background-drain';

AppRegistry.registerComponent(appName, () => App);

// Registered here, at module scope, and deliberately not from a component: a
// Headless task is dispatched with no Activity and no React tree, so a
// registration that waited for something to mount would not exist at the one
// moment Android looks for it.
AppRegistry.registerHeadlessTask(
  LOCATION_DRAIN_TASK_NAME,
  () => (data) => runBackgroundDrain(data),
);
