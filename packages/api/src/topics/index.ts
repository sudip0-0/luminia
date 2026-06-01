// Topics module barrel — Feed_Service topic mute / unmute.
//
// Exposes the mute/unmute persistence service (`muteTopic`, `unmuteTopic`), the
// injected data-access surface and its repository-backed factory, and the
// discriminated result types behind `POST /topics/{id}/mute` and
// `POST /topics/{id}/unmute` (Requirements 25.2-25.6).

export * from './mute.js';
