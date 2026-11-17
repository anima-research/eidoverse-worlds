// remotes.js for parts-test: motion.js reads serverNow(), lookats.js the remotes map; the real module's cone is every remote
// body (avatar.js, the renderer).
export const serverNow = () => Date.now();
// lookats.js (parts-test's look-at rows) walks remote bodies for @nearest; none here
export const remotes = new Map();
