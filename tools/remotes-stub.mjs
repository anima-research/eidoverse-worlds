// remotes.js for parts-test: motion.js reads serverNow() and nothing else; the real module's cone is every remote
// body (avatar.js, the renderer).
export const serverNow = () => Date.now();
