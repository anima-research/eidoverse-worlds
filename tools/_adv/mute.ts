// ATTACK 3 isolated: can a muted speaker unmute by reconnecting?
import { RTCPeerConnection, MediaStreamTrack, RTCRtpCodecParameters, RtpPacket, RtpHeader } from "werift";
import { Sfu } from "../../server/sfu.ts";
const CODEC = new RTCRtpCodecParameters({ mimeType:"audio/opus", clockRate:48000, channels:2, payloadType:111 });
const sleep=(ms:number)=>new Promise(r=>setTimeout(r,ms));
const neg=async(o:RTCPeerConnection,a:RTCPeerConnection)=>{const f=await o.createOffer();await o.setLocalDescription(f);
  await a.setRemoteDescription(o.localDescription!);const n=await a.createAnswer();await a.setLocalDescription(n);
  await o.setRemoteDescription(a.localDescription!);};
class FP { pc=new RTCPeerConnection({codecs:{audio:[CODEC]}}); mic=new MediaStreamTrack({kind:"audio"}); heard=0; seq=0;
  constructor(){ this.pc.addTransceiver(this.mic,{direction:"sendonly"});
    this.pc.ontrack=(e)=>e.track.onReceiveRtp.subscribe(()=>{this.heard++;}); }
  async speak(n:number){for(let i=0;i<n;i++){this.mic.writeRtp(new RtpPacket(
    new RtpHeader({payloadType:111,sequenceNumber:this.seq++,timestamp:this.seq*960,ssrc:42}),
    Buffer.from([1,2,3,i&0xff])));await sleep(6);} } }
const sfu=new Sfu({onNegotiationNeeded:()=>{}});
const spk=new FP(), lis=new FP();
await neg(spk.pc, sfu.createLeg("S",1).pc);
await neg(lis.pc, sfu.createLeg("L",1).pc);
sfu.setConsent("L","S",true); await sleep(30);
await neg(sfu.getLeg("L")!.pc, lis.pc); await sleep(500);
await spk.speak(8); await sleep(250);
console.log(`  baseline (consent, unmuted): heard=${lis.heard}`);
sfu.setMuted("S",true);
const h0=lis.heard; await spk.speak(8); await sleep(250);
console.log(`  muted: heard ${h0}->${lis.heard}  ${lis.heard===h0?"(mute works)":"(MUTE LEAKED)"}`);
// S reconnects under the same id; listener re-consents (normal rejoin).
const spk2=new FP();
await neg(spk2.pc, sfu.createLeg("S",2).pc);
sfu.setConsent("L","S",true); await sleep(40);
await neg(sfu.getLeg("L")!.pc, lis.pc); await sleep(600);
const h1=lis.heard; await spk2.speak(12); await sleep(400);
console.log(`  muted set after reconnect: ${JSON.stringify(sfu.diag().muted)}`);
console.log(`  after speaker reconnect: heard ${h1}->${lis.heard}`);
console.log(lis.heard===h1 ? "  PASS   mute survived the reconnect" : "  DEFECT mute BYPASSED by reconnecting");
sfu.closeAll(); process.exit(0);
