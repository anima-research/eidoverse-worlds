// Bind runtime geometry to the MCPL package's declared Three dependency.
import * as THREE from "three";
import { rigMath } from "../shared/rig.js";
export { glbJson, humanBones, isVrm0, PARENT, GLB_MAX_JSON } from "../shared/rig.js";
export const { worldPositions, worldRotations, makeAvatar, stature } = rigMath(THREE);
