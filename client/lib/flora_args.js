// client/lib/flora_args — moved to shared/flora_args.js (shape audit 10-16: the authority validates a preset name at write
// (assetref.js presetStrokes) and maps the old makeGrass knobs; readers expand it). Re-exported here for the client's imports.
export * from '../../shared/flora_args.js';
