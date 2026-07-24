// Static client configuration for the Lumina Mobile_App.

export const APP_NAME = 'Lumina';

const configuredApiBaseUrl = process.env.EXPO_PUBLIC_API_BASE_URL;

/**
 * Default API base URL. Android emulators cannot reach the host machine through
 * `localhost`; they use `10.0.2.2` for the development machine's loopback
 * interface. Override with `EXPO_PUBLIC_API_BASE_URL` for a physical device,
 * iOS simulator, or a non-default backend address.
 */
export const DEFAULT_API_BASE_URL =
  configuredApiBaseUrl ?? 'http://10.0.2.2:3000';
