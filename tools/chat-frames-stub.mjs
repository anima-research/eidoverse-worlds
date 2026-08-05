// chat-log-test substitutes this for frames.js. The stub is stateful so tests
// can hide the frame and watch the unread counters move.
export const frameStub = {
  visible: true,
  state: { collapsed: false },
  body: null,
  badge() {},
  toggle() {},
  show() { this.visible = true; },
  collapse(v) { this.state.collapsed = !!v; },
};
export function makeFrame() {
  frameStub.el = document.createElement('div');
  frameStub.body = document.createElement('div');
  frameStub.el.append(frameStub.body);
  document.body.append(frameStub.el);
  return frameStub;
}
