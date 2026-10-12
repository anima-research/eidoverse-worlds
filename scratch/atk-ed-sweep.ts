// @ts-nocheck  sweep my leftovers in the live gym, paced
import { sock, show } from "./atk-access-lib.ts";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const me = await sock(); await me.join("gym", "atk-ed-2");
const ids = process.argv.slice(2);
for (const id of ids) { const r = await me.req("delete", { id }); console.log(id, show(r)); await sleep(250); }
me.close(); process.exit(0);
