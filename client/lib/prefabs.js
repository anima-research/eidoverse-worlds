// prefabs: a library model that places WITH children (a Godot scene, a Unity prefab). Today: the glowing library models,
// whose lights main inferred at runtime and this protocol writes out (LEGACY-PINS item 6). Each light is the one
// translate-v1@31 would write for that model (import-v1/lamps.ts + lampPartsOf, recorded here: the client can't read GLB
// materials before placing); tools/prefab-lamps-test.ts re-measures every entry against the library.
const lamp = (pos, color, intensity) => ({ pos, light: { kind: 'point', color, intensity, range: 12, decay: 2, daytime: 'dim' } });
const M = (n) => `eidoverse/assets/models/${n}.glb`;
export const PREFABS = Object.freeze({
  [M('streetlight_lamp_light_street_blade_runner_cyberpunk')]: [lamp([0.0675, 0.9462, -0.0015], 0xffd9a0, 54.78), lamp([0, 2.5521, -0.228], 0xffd9a0, 24.1)],
  [M('scifi_art_deco_office_desk')]: [lamp([2.4606, 0.4722, 0], 0xda6000, 14.72)],
  [M('corner_lamp')]: [lamp([0, 0.389, 0], 0xffe7c4, 19.17)],
  [M('corner_camp_bulb')]: [lamp([0, -0.078, 0], 0xffc476, 68.47), lamp([0, -0.0846, 0], 0xffddad, 16.95)],
  [M('inanna_tech_cyber_scifi_sphere_orb')]: [lamp([0.9736, 0, 0], 0xff0000, 21.84), lamp([-0.9743, 0, 0], 0x0000ff, 21.84)],
  [M('parking_meter_electronic_street_blade_runner_cyberpunk')]: [lamp([-0.0027, 0.5456, 0.0002], 0xffd9a0, 29.66)],
  [M('scifi_cyberpunk_intermodal_shipping_container_crate_blue')]: [lamp([0.0005, 1.3248, -0.0021], 0xffd9a0, 16.23)],
});
/** The child creates a placed model brings, parented to `host` (a request's $name): [] for a model with no prefab. */
export const prefabOps = (lib, host, create) => (PREFABS[lib] ?? []).map((c, i) =>
  create(`${host}-lamp${i}`, { transform: { pos: [...c.pos] }, components: { parent: { to: host }, label: 'lamp', light: { ...c.light } } }));
