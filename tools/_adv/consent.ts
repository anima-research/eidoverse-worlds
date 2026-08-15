// ATTACK: does a SPEAKER takeover let the new body inherit the old consent/route?
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
console.log(`  gen1 with consent: heard=${lis.heard}`);
// A DIFFERENT PERSON now claims id "S" (takeover). Consent was for the OLD S.
const spk2=new FP();
await neg(spk2.pc, sfu.createLeg("S",2).pc);
await sleep(500);
console.log(`  consent['L S'] after takeover = ${(sfu as any).consent.get("L S")}`);
console.log(`  L.outbound.has('S')          = ${sfu.getLeg("L")?.outbound.has("S")}`);
const h0=lis.heard; await spk2.speak(12); await sleep(400);
console.log(`  new body speaks: heard ${h0}->${lis.heard}`);
console.log(lis.heard===h0 ? "  PASS   new speaker body required fresh consent"
                           : "  DEFECT audio without consent after takeover");
sfu.closeAll(); process.exit(0);
