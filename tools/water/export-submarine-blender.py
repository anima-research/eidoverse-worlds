"""Export the replacement mesh plus the separate Blueprint floor slabs."""
import bpy,sys,json,os
args=sys.argv[sys.argv.index('--')+1:]
source,output=args[:2]
parts=args[2] if len(args)>2 else os.path.join(os.path.dirname(__file__),'../../world-data/water/vessels.json')
bpy.ops.wm.open_mainfile(filepath=source)
# Unreal substitutes M_Glass after FBX import; reproduce that material intent
# in glTF instead of exporting Blender's opaque placeholder.
glass=bpy.data.materials['V_Glass']
p=glass.node_tree.nodes.get('Principled BSDF')
p.inputs['Base Color'].default_value=(.65,.85,.88,1)
p.inputs['Alpha'].default_value=.16
p.inputs['Metallic'].default_value=0
p.inputs['Roughness'].default_value=.08
glass.diffuse_color=(.65,.85,.88,.16)
glass.surface_render_method='DITHERED'
# These are real Blueprint floor components, not part of PressureVessels.blend.
for c in json.load(open(parts))['BP_Cyclops']:
 if not c['name'].startswith('Floor_'):continue
 bpy.ops.mesh.primitive_cube_add(size=100,location=c['p'])
 o=bpy.context.object;o.name='SM_Submarine_'+c['name'];o.scale=c['scale']
 o.data.materials.append(bpy.data.materials['V_Graphite'])
 bpy.ops.object.transform_apply(location=False,rotation=False,scale=True)
bpy.ops.object.select_all(action='DESELECT')
for o in bpy.data.objects:
 if o.name.startswith('SM_Submarine'):o.select_set(True)
bpy.ops.export_scene.gltf(filepath=output,use_selection=True,export_format='GLB')
