# Builds the bar's model for the 3D view from the bar's FBX: glass with transmission, opaque glowing screens 2 mm
# BEHIND the glass, placeholder pictures for the screens. The hierarchy and the pivots of the FBX are kept as they
# are: nothing is regrouped, no pivot is guessed.
#   Blender -b --python build_glb.py -- <model.fbx> <texture dir with s_*.jpg and busy-bar_emissive.png> <work dir for generated images> <out.glb>
import bpy, sys, math, json, numpy as np
from mathutils import Vector, Matrix
fbx, d, work, out = sys.argv[sys.argv.index('--') + 1:][:4]
T = 0.25                                   # glass tint: how much light the glass lets through
GAP = 0.0020                               # screens sit 2 mm behind the glass
bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.fbx(filepath=fbx)
for o in list(bpy.data.objects):
    if o.type == 'CAMERA': bpy.data.objects.remove(o)
root = bpy.data.objects['Remesh']
parts = [o for o in bpy.data.objects if o is not root]
meshes = [o for o in parts if o.type == 'MESH']

# 1. Units and axes. The FBX is Y-up in millimetres under a root that carries the turn to Blender's Z-up and the scale 0.001.
#    glTF is Y-up in metres, so every node of the glTF can keep exactly the local frame it has in the FBX:
#    the root's turn and scale go into the mesh data, each node keeps its position and its own axes.
def world_points(o):
    n = len(o.data.vertices); co = np.empty(n * 3); o.data.vertices.foreach_get('co', co); mw = np.array(o.matrix_world)
    return co.reshape(n, 3) @ mw[:3, :3].T + mw[:3, 3]
before = {o.name: world_points(o) for o in meshes}
to_fbx_axes = Matrix.Rotation(math.pi / 2, 4, 'X').inverted()          # undoes the root's turn on the node's own side
old_world = {o.name: o.matrix_world.copy() for o in parts}
new_world = {}
for o in parts:
    loc, rot, scl = old_world[o.name].decompose()
    assert abs(scl.x - scl.y) < 1e-9 and abs(scl.x - scl.z) < 1e-9 and scl.x > 0, ('non-uniform scale', o.name, scl)
    new_world[o.name] = Matrix.Translation(loc) @ (rot.to_matrix().to_4x4() @ to_fbx_axes)
for o in meshes:
    assert o.data.users == 1, o.name
    o.data.transform(new_world[o.name].inverted() @ old_world[o.name]); o.data.update()
parent_of = {o.name: (o.parent.name if o.parent is not root else None) for o in parts}

# The stage turns the bar around the middle of its body, as v2 did; the model itself stays as it stands on the table.
bb = [old_world['body'] @ Vector(c) for c in bpy.data.objects['body'].bound_box]
centre = Vector([(min(v[i] for v in bb) + max(v[i] for v in bb)) / 2 for i in range(3)])
bar = bpy.data.objects.new('bar', None); model = bpy.data.objects.new('model', None)
for e in (bar, model): bpy.context.scene.collection.objects.link(e)
model.parent = bar; model.location = -centre
model_world = Matrix.Translation(-centre)
for o in parts:
    p = parent_of[o.name]
    o.parent = bpy.data.objects[p] if p else model; o.matrix_parent_inverse = Matrix.Identity(4)
    o.matrix_basis = (new_world[p].inverted() if p else Matrix.Identity(4)) @ new_world[o.name]
bpy.data.objects.remove(root)
bpy.context.view_layer.update()
worst = max(np.abs(world_points(o) - (before[o.name] - np.array(centre))).max() for o in meshes)
print('NORMALISED: body centre', [round(v, 5) for v in centre], 'largest vertex move, mm', round(worst * 1000, 6))
assert worst < 1e-6
def in_model(o): return model_world.inverted() @ o.matrix_world            # coordinates as the model stands on the table

def tex(name, colorspace='sRGB'):
    im = bpy.data.images.load(d + '/s_%s.jpg' % name); im.colorspace_settings.name = colorspace; return im

# 2. Where the back display sits on the rear glass: the lit island of the baked emissive texture.
em = bpy.data.images.load(d + '/busy-bar_emissive.png'); w, h = em.size
px = np.array(em.pixels[:], dtype=np.float32).reshape(h, w, 4)
o = bpy.data.objects['rear_glas_remesh']; me = o.data; me.calc_loop_triangles(); uv = me.uv_layers.active.data; mw = in_model(o)
pts = []
for t in me.loop_triangles:
    P = [mw @ me.vertices[v].co for v in t.vertices]; U = [uv[l].uv for l in t.loops]
    for i in range(8):
        for j in range(8 - i):
            a = (i + .3) / 8.6; b = (j + .3) / 8.6; c = 1 - a - b
            u = U[0] * a + U[1] * b + U[2] * c; p = P[0] * a + P[1] * b + P[2] * c
            x = min(w - 1, max(0, int(u.x * w))); y = min(h - 1, max(0, int(u.y * h)))
            if px[y, x, :3].min() > 0.15: pts.append((p.x, p.y, p.z, u.x, u.y))
A = np.array(pts); ymin, zmin = A[:, 1].min(), A[:, 2].min(); ymax, zmax = A[:, 1].max(), A[:, 2].max()
umin, vmin, umax, vmax = A[:, 3].min(), A[:, 4].min(), A[:, 3].max(), A[:, 4].max()
coef, *_ = np.linalg.lstsq(np.c_[A[:, 1], A[:, 2], np.ones(len(A))], A[:, 0], rcond=None)
inward = Vector((1, -coef[0], -coef[1])).normalized()                        # from the rear glass into the bar
print('BACK rect y', ymin, ymax, 'z', zmin, zmax, 'uv', umin, vmin, umax, vmax, 'plane', coef, 'lean, deg', round(math.degrees(math.atan(coef[1])), 2))
def back_point(y, z): return Vector((coef[0] * y + coef[1] * z + coef[2], y, z)) + inward * GAP

# Rear glass keeps its printed base color, but the display window becomes tinted glass.
base = tex('basecolor'); bw, bh = base.size
bp = np.array(base.pixels[:], dtype=np.float32).reshape(bh, bw, 4)
m = 0.004                                                           # a little margin around the window, in UV
bp[int((vmin - m) * bh):int((vmax + m) * bh), int((umin - m) * bw):int((umax + m) * bw), :3] = T
rear_img = bpy.data.images.new('s_basecolor_rear', bw, bh); rear_img.pixels = bp.ravel().tolist()
rear_img.filepath_raw = work + '/s_basecolor_rear.png'; rear_img.file_format = 'PNG'; rear_img.save()

def node_tex(nt, img, closest=False):
    n = nt.nodes.new('ShaderNodeTexImage'); n.image = img
    if closest: n.interpolation = 'Closest'
    return n
def mat_pbr():
    m = bpy.data.materials.new('bar'); m.use_nodes = True; nt = m.node_tree; b = nt.nodes['Principled BSDF']
    nt.links.new(node_tex(nt, base).outputs[0], b.inputs['Base Color'])
    nt.links.new(node_tex(nt, tex('metallic', 'Non-Color')).outputs[0], b.inputs['Metallic'])
    nt.links.new(node_tex(nt, tex('roughness', 'Non-Color')).outputs[0], b.inputs['Roughness'])
    nm = nt.nodes.new('ShaderNodeNormalMap'); nt.links.new(node_tex(nt, tex('normal', 'Non-Color')).outputs[0], nm.inputs['Color']); nt.links.new(nm.outputs[0], b.inputs['Normal'])
    return m
def mat_glass(name, img=None):
    m = bpy.data.materials.new(name); m.use_nodes = True; nt = m.node_tree; b = nt.nodes['Principled BSDF']
    b.inputs['Transmission Weight'].default_value = 1.0; b.inputs['IOR'].default_value = 1.5
    b.inputs['Roughness'].default_value = 0.05; b.inputs['Metallic'].default_value = 0.0
    if img: nt.links.new(node_tex(nt, img).outputs[0], b.inputs['Base Color'])
    else: b.inputs['Base Color'].default_value = (T, T, T, 1)
    return m
def mat_emit(name, strength, img):
    m = bpy.data.materials.new(name); m.use_nodes = True; nt = m.node_tree; b = nt.nodes['Principled BSDF']
    b.inputs['Base Color'].default_value = (0, 0, 0, 1); b.inputs['Roughness'].default_value = 0.6
    b.inputs['Emission Strength'].default_value = strength
    nt.links.new(node_tex(nt, img, closest=True).outputs[0], b.inputs['Emission Color'])   # NEAREST sampling reaches the scene
    return m
def placeholder(name, w, h):
    im = bpy.data.images.new(name, w, h); p = np.zeros((h, w, 4), dtype=np.float32); p[..., 3] = 1
    p[::2, ::2, :3] = (0.9, 0.5, 0.1); p[h // 2 - 1:h // 2 + 1, :, :3] = 1; im.pixels = p.ravel().tolist()
    im.filepath_raw = work + '/' + name + '.png'; im.file_format = 'PNG'; im.save(); return im

for mt in list(bpy.data.materials): bpy.data.materials.remove(mt)       # the FBX brings eight materials that no mesh uses
barm = mat_pbr(); led = mat_emit('status_led', 0.0, placeholder('led_ph', 2, 2))
glass_front = mat_glass('glass_front'); glass_rear = mat_glass('glass_rear', rear_img)
for ob in meshes:
    ob.data.materials.clear()
    ob.data.materials.append(led if ob.name.startswith('led_light') else glass_front if ob.name == 'front_glass'
                             else glass_rear if ob.name == 'rear_glas_remesh' else barm)

# 3. Screens. Flat quads with their own 0..1 UV, parented to the fixed part of the model.
def quad(name, corners, mat):                    # corners: bottom-left, bottom-right, top-right, top-left as the viewer sees them
    me = bpy.data.meshes.new(name); me.from_pydata([Vector(c) for c in corners], [], [(0, 1, 2, 3)])
    uvl = me.uv_layers.new(name='UVMap')
    for l, u in zip(uvl.data, [(0, 0), (1, 0), (1, 1), (0, 1)]): l.uv = u
    ob = bpy.data.objects.new(name, me); bpy.context.scene.collection.objects.link(ob); me.materials.append(mat)
    ob.parent = model; ob.matrix_parent_inverse = Matrix.Identity(4); return ob
# Front: the model's own `screen` plane is the LED matrix, already 2 mm behind the front glass. Its four corners, as the viewer sees them.
s = bpy.data.objects['screen']; sm = in_model(s); c4 = [sm @ v.co for v in s.data.vertices]; assert len(c4) == 4
lo = sorted(sorted(c4, key=lambda v: v.z)[:2], key=lambda v: v.y); hi = sorted(sorted(c4, key=lambda v: v.z)[2:], key=lambda v: v.y)
front_corners = [lo[0], lo[1], hi[1], hi[0]]
fn = (front_corners[1] - front_corners[0]).cross(front_corners[3] - front_corners[0]).normalized()
g = bpy.data.objects['front_glass']; gm = in_model(g); depth = sorted((gm @ v.co - front_corners[0]).dot(fn) for v in g.data.vertices if abs((gm @ v.co).y) < 0.06)
print('FRONT screen', [[round(x, 5) for x in c] for c in front_corners], 'lean, deg', round(math.degrees(math.atan2(fn.z, fn.x)), 2),
      'glass in front of it, mm: from', round(depth[0] * 1000, 2), 'to', round(depth[-1] * 1000, 2))
meshes.remove(s); bpy.data.objects.remove(s)
quad('front_screen', front_corners, mat_emit('front_screen', 1.0, placeholder('front_ph', 72, 16)))
back_corners = [back_point(ymax, zmin), back_point(ymin, zmin), back_point(ymin, zmax), back_point(ymax, zmax)]
gd = sorted((mw @ v.co - back_corners[0]).dot(-inward) for v in me.vertices if ymin < (mw @ v.co).y < ymax and zmin < (mw @ v.co).z < zmax)
print('BACK screen', [[round(x, 5) for x in c] for c in back_corners], 'glass in front of it, mm: from', round(gd[0] * 1000, 2), 'to', round(gd[-1] * 1000, 2))
quad('back_screen', back_corners, mat_emit('back_screen', 1.0, placeholder('back_ph', 160, 80)))

bpy.ops.export_scene.gltf(filepath=out, export_format='GLB', export_image_format='AUTO', export_apply=True, export_yup=True,
                          export_tangents=True, export_cameras=False, export_lights=False)
print('DONE')
