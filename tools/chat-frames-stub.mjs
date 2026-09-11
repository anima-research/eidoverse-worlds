// chat-log-test substitutes this for frames.js. The stub is stateful so tests
// can hide the frame and watch the unread counters move. Only what the real frame api has (frames.js:273).
export const frameStub = {
  visible: true,
  body: null,
  badge() {},
  toggle() {},
  show() { this.visible = true; },
};
export function makeFrame() {
  frameStub.el = document.createElement('div');
  frameStub.body = document.createElement('div');
  frameStub.el.append(frameStub.body);
  document.body.append(frameStub.el);
  return frameStub;
}
// domquad.js walks the frame registry; nothing to walk in the chat cone
export const allFrames = () => [];
export const getFrame = () => null;
