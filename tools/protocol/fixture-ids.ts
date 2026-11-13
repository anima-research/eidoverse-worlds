// tools/protocol/fixture-ids.ts — imported for its effect by in-process suites whose fixtures seed the ids they read
// (`create {id: "table"}` straight into the authority, no wire). R 10-17: a WRITER never chooses an id; a fixture is not a
// writer, so it goes through the authority's in-process fixture seam, as a fork's copy keeps ids. ids-check covers the
// refusal a writer gets, and holds every runtime file to never calling fixtureIds.
import { fixtureIds } from "../../shared/protocol/authority.js";
fixtureIds(true);
