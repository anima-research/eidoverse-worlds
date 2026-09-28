// Absolute normalized-humanoid rotations, radians (XYZ Euler). VRM's neutral
// arms point sideways: adding a Z twist to a relaxed idle folds them behind
// the torso. Own the shoulders, upper/lower arms and hands during the stroke.
export function swimPose(time, surface=false){
 const stroke=.5+.5*Math.sin(time*2.5),kick=Math.sin(time*4);
 const pose={};
 for(const [side,sign] of [['left',1],['right',-1]]){
  pose[side+'Shoulder']=[0,0,0];
  pose[side+'UpperArm']=[0,-sign*(.25+.2*stroke),sign*(surface?-.55-.15*stroke:.25+.65*stroke)];
  pose[side+'LowerArm']=[0,-sign*.25,sign*(.25+.55*(1-stroke))];
  pose[side+'Hand']=[0,0,0];
  pose[side+'UpperLeg']=[sign*.18*kick,0,0];
  pose[side+'LowerLeg']=[Math.max(0,-sign*kick)*.2,0,0];
 }
 return pose;
}
