// Presence clip slots and the library files that realize them.
export const CLIP_SLOTS = ['idle', 'walk', 'run', 'sit', 'lie', 'jump', 'climb', 'fly', 'soar'];
export const CLIP_FILES = { sit: 'sitting_on_ground', lie: 'sit_laying_on_ground', climb: 'climbLedge', fly: 'fallIdle', soar: 'fallIdle' };
export const CLIP_SPEED = { fly: 0, soar: 0, idle: 0, walk: 1.55, run: 4.0, sit: 0, lie: 0, jump: 0, climb: 0 };
export const SEAT_CLIP_FILE = 'sitting_normal_chair';
