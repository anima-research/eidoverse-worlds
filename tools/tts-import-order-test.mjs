// The FILE ask must come first; the folder is only offered after a decline.
const order = [];
async function addFile({ filePickReturns }) {
  order.length = 0;
  order.push('pick .onnx');
  let more = await (async () => { order.push('ask for matching FILE'); return filePickReturns; })();
  if (!more?.length) {
    const paired = await (async () => { order.push('offer FOLDER'); return null; })();
    if (paired) return 'paired';
  }
  return more?.length ? 'done via file' : 'half-finished row';
}
await addFile({ filePickReturns: [{}] });
console.log('user picks the file :', order.join(' → '));
const a = order.join()==='pick .onnx,ask for matching FILE';
await addFile({ filePickReturns: null });
console.log('user declines file  :', order.join(' → '));
const b = order[1]==='ask for matching FILE' && order[2]==='offer FOLDER';
console.log(a && b ? 'PASS — file first, folder only after a decline' : 'FAIL');
