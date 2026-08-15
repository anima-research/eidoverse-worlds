// E3b: MUTATION — delete the consent check from fanout. Does the shipped
// "fail-closed: 0 packets to bob before consent" assertion kill this mutant?
import { RTCPeerConnection, MediaStreamTrack, RTCRtpCodecParameters, RtpPacket, RtpHeader } from "werift";
import { Sfu } from "../../server/sfu.ts";
const CODEC=new RTCRtpCodecParameters({mimeType:"audio/opus",clockRate:48000,channels:2,payloadType:111});
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
// MUTANT: consent check removed entirely from the hot path.
(sfu as any).fanout=function(from:any,rtp:any){ from.rxPackets++;
  if(from.closed||this.muted.has(from.id))return;
  for(const [lid,l] of this.legs){ if(lid===from.id||l.closed)continue;
    /* CONSENT CHECK DELETED */
    const t=l.outbound.get(from.id); if(!t)continue; t.writeRtp(rtp); this.forwarded++; } };
const alice=new FP(), bob=new FP();
await neg(alice.pc, sfu.createLeg("alice",1).pc);
await neg(bob.pc, sfu.createLeg("bob",1).pc);
await sleep(700);
await alice.speak(15); await sleep(300);
console.log(`  MUTANT fanout (no consent check): bob.heard=${bob.heard}  alice.rx=${sfu.getLeg("alice")?.rxPackets}`);
console.log(bob.heard===0
  ? "  MUTANT SURVIVED — 'fail-closed: 0 packets before consent' passes with the consent check DELETED"
  : "  mutant killed — the assertion detects a missing consent check");
sfu.closeAll(); process.exit(0);
