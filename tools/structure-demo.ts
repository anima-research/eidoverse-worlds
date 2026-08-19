// Author a demo griddled house into a world, over real websockets.
//
//   WORLD_URL=ws://localhost:8961/ws JOIN_TOKEN=test-door bun run tools/structure-demo.ts [world]
//
// Two verbs build a whole building: a `spawn` for the anchor entity and one
// `comp {type:"structure"}` carrying the grid. That is the entire wire cost of
// a three-room house — which is the argument for the component lane in one
// line. (The anchor's lib is the placeholder this slice rides until a
// `structure` entity can be spawned without one; the realizer hides it.)

const URL_ = process.env.WORLD_URL ?? 'ws://localhost:8961/ws';
const TOKEN = process.env.JOIN_TOKEN ?? 'test-door';
const WORLD = process.argv[2] ?? 'structdemo';
const ID = process.env.DEMO_ID ?? 'builder';

// A 6×4 house: kitchen and bedroom down the west side, a hall running the
// full depth on the east, a front door to the south and three windows.
//
//        x=0    1    2    3    4    5    6
//   z=0   ═════════════════╤═════════════       ═ exterior   ║ interior
//         │ kitchen        ║                │
//   z=2   ├────────────────╫    hall        │   ╫ = doored
//         │ bedroom        ║                │
//   z=4   ═══════[door]════╧═════════════════
const wallsRun = (axis: 0 | 1, along: number[], fixed: number) =>
  along.map((v) => (axis === 0 ? [0, v, fixed] : [1, fixed, v]));

const STRUCTURE = {
  tile: 1.0, wallH: 2.8, wallT: 0.15,
  labels: { '0,0': 'kitchen', '0,2': 'bedroom', '3,0': 'hall' },
  levels: [{
    y: 0,
    tiles: Array.from({ length: 6 }, (_, x) => Array.from({ length: 4 }, (_, z) => [x, z])).flat(),
    walls: [
      ...wallsRun(0, [0, 1, 2, 3, 4], 0),      // north exterior (corner cell cut off)
      ...wallsRun(0, [0, 1, 2, 3, 4, 5], 4),   // south exterior
      ...wallsRun(1, [0, 1, 2, 3], 0),         // west exterior
      ...wallsRun(1, [1, 2, 3], 6),            // east exterior (top cell cut off)
      [2, 5, 0],                               // a Sims-style DIAGONAL corner
      ...wallsRun(0, [0, 1, 2], 2),            // kitchen | bedroom
      ...wallsRun(1, [0, 1, 2, 3], 3),         // west rooms | hall
    ],
    apertures: [
      [1, 3, 0, 'door'],      // kitchen → hall
      [1, 3, 3, 'door'],      // bedroom → hall
      [0, 4, 4, 'door'],      // hall → outside (the front door)
      [0, 1, 0, 'window'],    // kitchen, north
      [0, 1, 4, 'window'],    // bedroom, south
      [2, 5, 0, 'window'],    // the diagonal gets a window too
      [1, 6, 1, 'window'],    // hall, east
    ],
  }],
};

const ws = new WebSocket(`${URL_}?token=${encodeURIComponent(TOKEN)}`);
const send = (o: unknown) => ws.send(JSON.stringify(o));

ws.onopen = () => send({ type: 'join', world: WORLD, id: ID, token: TOKEN });

ws.onmessage = (ev: MessageEvent) => {
  const m = JSON.parse(String(ev.data));
  if (m.type === 'snapshot' || m.type === 'state' || m.type === 'welcome') {
    send({ type: 'verb', verb: 'spawn', args: { id: 'house1', lib: 'eidoverse/assets/models/crate_large_red.glb', pos: [0, 0, 0], yaw: 0 } });
    send({ type: 'verb', verb: 'comp', args: { id: 'house1', type: 'structure', data: STRUCTURE } });
    const bytes = JSON.stringify(STRUCTURE).length;
    console.log(`authored house1 into "${WORLD}" — ${bytes} bytes of component (8192 cap), ${STRUCTURE.levels[0].walls.length} walls, ${STRUCTURE.levels[0].tiles.length} tiles`);
    setTimeout(() => { ws.close(); process.exit(0); }, 1200);
  }
  if (m.type === 'error') console.error('refused:', m.error);
};
ws.onerror = (e: Event) => { console.error('ws error', e); process.exit(1); };
