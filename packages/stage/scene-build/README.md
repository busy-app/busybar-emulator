# Building the scene of the 3D view

A maintainer's job, done when the model changes (steps 1 and 2) or a scene delivery arrives (step 3). A user of the emulator never
needs any of this: the built scene, `../frame/scene/bar.trd`, is in the repository.

What it takes for the model: Blender 4.2, Python 3 with Pillow, and the bar's model. The scene needs nothing here.

1. **The model as GLB.** `build_glb.py` (Blender 4.2) makes `bar3.glb` from the bar's FBX and its textures (the
   package of the model, its pictures scaled down to 2048 px as `s_basecolor.jpg`, `s_metallic.jpg`,
   `s_roughness.jpg`, `s_normal.jpg`): the bar's own groups and pivots, the two screens as planes behind the glass,
   their placeholder pictures named `front_ph` and `back_ph`.

   ```sh
   Blender -b --python build_glb.py -- busy-bar.fbx <textures> <a work folder> bar3.glb
   ```

2. **The orange.** The model's base color picture paints the orange parts a dull brown-orange; `tune_glb.py` paints
   them the orange of the bar. Nothing else of the file changes.

   ```sh
   python3 -I tune_glb.py bar3.glb bar.glb
   ```

3. **The scene is not built here.** It is owned by the Tride agent; the master copy is a `.trideproject` kept
   outside this repository. It delivers a folder per change: `bar.trd`, `bar.json`, `scene.json` (the contract),
   `CHANGES.md`, `shots/`.

   **Ask for changes through the Tride agent** (one message: what, why, how we know it's done). Install a delivery
   with `record.mjs --delivery ... --install`:

   ```sh
   node record.mjs --delivery <the delivery folder> --install
   node --test ../test/*.test.mjs
   ```

   `--delivery` checks the delivery's checksums, `--install` first copies `bar.trd`, `bar.json` and `scene.json` into
   `../frame/scene`, and `versions.json` records the delivery, the editor and the model's GLB. `--model` and `--glb`
   record the checksums of the model's files when steps 1 and 2 are redone.

4. **Look at it.** Start the emulator, open the device window, switch to 3D, and look at the bar from the front, from
   above and from the back before committing a delivery.

## What the page relies on

`../frame/stage.js` writes the scene's inputs by name and reads `bar.json`. The contract is `../frame/scene/scene.json`:
inputs with types and meaning, the interactions, the camera, the uids of `bar.json`, with `readByStage: true` on
everything the page reads. Changing one of those is a breaking change, agreed in advance.
`../test/files.test.mjs` checks that the page and the contract agree.

## Notes

- The wheel's drag plane goes through `wheel_grip`, an empty node on the wheel's axis at the height of its top, not through
  the wheel's base: with the base the mark on the wheel misses the finger by up to 19 degrees when the bar is seen at an angle.
- `listeners.set` wants `throw: 0` on a drag that turns an input, though the format lets it be left out.
- The editor's `light.set-property` accepts a property name it does not know and changes nothing: after a change to
  the lights, read the scene's `manifest.json` (the `.trd` is a zip archive) to see that it took.
- The mode switch's step, 38.5 degrees, is read off the marks printed on the bar's top; it has not been compared with
  a bar.
