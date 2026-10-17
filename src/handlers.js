// -----------------------------------------------------------------------------
// The SDK handlers, wired to the app. Shared by index.js and the end-to-end
// tests, so the tests run the exact wiring of the container.
// -----------------------------------------------------------------------------

import { ACTIONS } from './constants.js';

export function registerHandlers(gladys, app, logger) {
  // Discovery: the devices are published at each read; Scan reads them again.
  gladys.onScanRequest(() => app.rescan());
  gladys.onDeviceCreated((device) => app.deviceCreated(device));
  gladys.onDeviceUpdated((device) => app.deviceCreated(device));
  gladys.onDeviceDeleted((device) => app.deviceDeleted(device));

  // Commands.
  gladys.onSetValue((device, feature, value) => app.setValue(device, feature, value));

  // Configuration screen button.
  gladys.onAction(ACTIONS.TEST, () => app.testConnection());

  // Configuration changed by the user (or the address found on the network, saved).
  gladys.onConfigUpdated((config) => app.configUpdated(config));

  // Connection lifecycle (also after every reconnection to Gladys): a
  // reconnection keeps the wait after a failure (a refused key included);
  // nothing is read from Homey while Gladys is away.
  gladys.on('connected', async () => {
    try {
      await app.start(await gladys.getConfig(), { reconnect: true });
    } catch (err) {
      logger?.error('Start failed', err);
    }
  });
  gladys.on('disconnected', () => app.stop());
}
