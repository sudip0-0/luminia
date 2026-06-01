// Notification_Service module barrel — push hygiene (Requirement 18).
//
// Exposes the fixed daily copy, the rolling-window constant, the narrow
// injected interfaces (preference store, rate-limit store, push sender), the
// discriminated result types, and the `sendDaily` / `setPreferences` services.

export * from './service.js';
