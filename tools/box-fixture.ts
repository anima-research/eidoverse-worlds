// A real, tiny GLB through the normal parser; this door test needs no private
// asset closure. Its non-flat bounding box covers all three axes.
export function modelBytes() {
  const positions = new Float32Array([-0.5,0,-0.5, 0.5,0,-0.5, 0,1,0.5]);
  const json = JSON.stringify({ asset:{version:'2.0'}, scene:0, scenes:[{nodes:[0]}], nodes:[{mesh:0}],
    meshes:[{primitives:[{attributes:{POSITION:0}}]}], buffers:[{byteLength:positions.byteLength}],
    bufferViews:[{buffer:0,byteLength:positions.byteLength}],
    accessors:[{bufferView:0,componentType:5126,count:3,type:'VEC3',min:[-0.5,0,-0.5],max:[0.5,1,0.5]}] });
  const chunk = Buffer.from(json.padEnd(Math.ceil(json.length / 4) * 4, ' '));
  const out = Buffer.alloc(28 + chunk.length + positions.byteLength);
  out.writeUInt32LE(0x46546c67,0); out.writeUInt32LE(2,4); out.writeUInt32LE(out.length,8);
  out.writeUInt32LE(chunk.length,12); out.writeUInt32LE(0x4e4f534a,16); chunk.copy(out,20);
  out.writeUInt32LE(positions.byteLength,20+chunk.length); out.writeUInt32LE(0x004e4942,24+chunk.length);
  Buffer.from(positions.buffer).copy(out,28+chunk.length);
  return out;
}
