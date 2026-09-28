// Eidoverse's scene-facing adapter around pinned standalone Eanpa Sky.
// Eanpa owns the sky/weather implementation; this host owns world policy,
// existing library assets, light adoption, renderer scheduling and teardown.
const A = 'eidoverse/assets/sky/';
const readTex = async (path, srgb = false) => globalThis.loadImageTexture(
  globalThis.Deno.readFileSync(path), srgb ? { srgb: true } : {},
);

export async function makeEanpaEarth({
  scene, camera, renderer, hours = 12, clouds = 'cumulus', weather = 'clear', weatherK = 1,
  sun, hemi, audio = false, weatherOptions = {}, loadLegacyModule,
} = {}) {
  if (typeof globalThis.makeSkySystem !== 'function' || typeof globalThis.makeWeatherSystem !== 'function') {
    throw new Error('current standalone Eanpa modules were not loaded');
  }
  const textures = {
    stars: await readTex(A + 'starmap_tycho_4k.jpg', true),
    moon: await readTex(A + 'moon_color_1k.jpg', true),
  };
  const sky = await globalThis.makeSkySystem({
    scene, textures,
    opts: { hours, clouds, moonAngularDeg: 0.55 },
  });
  sky.wrapCloudShadows?.(scene);
  const wx = await globalThis.makeWeatherSystem({
    scene, sky,
    opts: { ...weatherOptions, textures: {
      bolt: await readTex('eidoverse/assets/particle_textures/trace_06.png'),
      drop: await readTex(A + 'rain_streak.png', true),
    } },
  });
  wx.wrapScene();
  if (weather) wx.setWeather(weather, weatherK);
  let wxAudio = null;
  if (audio && loadLegacyModule) {
    await loadLegacyModule('weather_audio.js');
    wxAudio = globalThis.makeWeatherAudio?.({ weather: wx, camera, quiet: true }) ?? null;
  }
  let cycle = null;
  const lights = () => ({ sun: sun ?? globalThis._sun, hemi: hemi ?? globalThis._hemi });
  const api = {
    world: 'earth', label: 'Earth',
    setTime(h) { cycle = null; sky.setTime(((h % 24) + 24) % 24); return api; },
    dayCycle({ startHour = 6, seconds = 60 } = {}) { cycle = { startHour, seconds }; return api; },
    setClouds(type, shape) { sky.setClouds(type, shape); return api; },
    transitionClouds(type, seconds = 2.5) { sky.transitionClouds(type, seconds); return api; },
    setWeather(name, k = 1) { wx.setWeather(name, k); return api; },
    transitionTo(name, k = 1, seconds = 45) { wx.transitionTo(name, k, seconds); return api; },
    setColors(colors = {}) {
      sky.setColors?.({ cloud: colors.cloud, star: colors.star ?? colors.sun, sky: colors.sky });
      if (colors.rain) wx.setColors?.({ rain: colors.rain });
      return api;
    },
    wrapScene() { wx.wrapScene(); return api; },
    applyToLights() {
      const l = lights(); sky.applyToLights({ ...l, fog: scene.fog });
      const dim = wx.sunDim?.() ?? 1;
      if (l.sun) l.sun.intensity *= dim;
      if (l.hemi) l.hemi.intensity *= 0.5 + dim * 0.5;
      return api;
    },
    update(t) {
      if (cycle) sky.setTime((cycle.startHour + t * (24 / cycle.seconds)) % 24);
      sky.update(t, camera);
      wx.update(t, camera);
      wxAudio?.update?.(t);
      api.applyToLights();
      sky.prepareOptimizedCaches?.(renderer, camera);
      return api;
    },
    async bakeEnv(options = {}) { await sky.bakeEnv(renderer, { ...options, scene }); return api; },
    enableReflections(options = {}) { sky.enableReflections?.(camera, options); return api; },
    dispose() {
      wxAudio?.dispose?.();
      wx.dispose?.();
      sky.dispose?.();
    },
    _internals: { sky, weather: wx },
  };
  api.applyToLights();
  return api;
}
