"""Read-only export of the currently loaded Unreal ocean level."""
import unreal,json,os,traceback
OUT=os.environ.get('EIDO_EXPORT_DIR',os.path.join(unreal.Paths.project_saved_dir(),'EidoverseExport'))
os.makedirs(OUT,exist_ok=True)
try:
 w=unreal.get_editor_subsystem(unreal.UnrealEditorSubsystem).get_editor_world()
 actors=unreal.get_editor_subsystem(unreal.EditorActorSubsystem).get_all_level_actors()
 groups={'terrain':[],'habitat':[],'submarine':[],'platform':[],'scenery':[]}
 air={}; starts=[]
 def vec(v): return [v.y/100,v.z/100,v.x/100]
 for a in actors:
  label=a.get_actor_label(); cls=a.get_class().get_name()
  if a.get_editor_property('hidden'):continue
  if cls=='BP_DiverPawn_C':starts.append(vec(a.get_actor_location()));continue
  if cls.startswith('CineCamera') or 'Ocean' in cls or 'Water' in cls:continue
  meshes=[c for c in a.get_components_by_class(unreal.StaticMeshComponent) if c.static_mesh and c.is_visible() and not c.get_editor_property('hidden_in_game')]
  if not meshes:continue
  group='terrain' if label.startswith('Temperate Shelf') else 'habitat' if cls=='BP_Habitat_C' else 'submarine' if cls=='BP_Cyclops_C' else 'platform' if cls=='SurfaceBoardingPlatform' else 'scenery'
  groups[group].append(a)
  for c in a.get_components_by_class(unreal.BoxComponent):
   if 'AirVolume' in c.get_name() or 'WaterAirVolume' in [str(t) for t in c.component_tags]:
    p=c.get_world_location(); e=c.get_scaled_box_extent(); r=c.get_world_rotation();q=r.quaternion()
    # Match the legacy native adapter's cyclic axis permutation.
    air.setdefault(group,[]).append({'center':vec(p),'size':[e.y/50,e.z/50,e.x/50],'q':[q.y,q.z,q.x,q.w]})
 opts=unreal.GLTFExportOptions();opts.export_uniform_scale=.01
 opts.bake_material_inputs=unreal.GLTFMaterialBakeMode.SIMPLE
 opts.default_material_bake_size=unreal.GLTFMaterialBakeSize(256,256)
 opts.export_hidden_in_game=False;opts.export_cameras=False;opts.export_lights=False
 result={'world':w.get_path_name(),'air':air,'spawn':starts[0] if starts else [29,-25,89],'groups':{}}
 for name,aa in groups.items():
  if not aa:continue
  path=OUT+'/'+name+'.glb'
  msgs=unreal.GLTFExporter.export_to_gltf(w,path,opts,set(aa))
  result['groups'][name]={'file':name+'.glb','actors':[a.get_actor_label() for a in aa],'messages':str(msgs)}
  json.dump(result,open(OUT+'/export.json','w'),indent=2)
 unreal.log('WEB_WATER_EXPORT_DONE')
except: open(OUT+'/export_error.txt','w').write(traceback.format_exc())
