// @ts-nocheck
import { sock, show } from "./atk-access-lib.ts";
const own = await sock(); await own.join("gym", "rab");
console.log("grant:", show(await own.req("set", { id: "@world", component: "roles:u-r6mcsu5yvwf4azlcjogo", value: { role: "builder", can: { editWorld: true } } })));
own.close(); process.exit(0);
