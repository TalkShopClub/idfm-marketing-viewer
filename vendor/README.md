# Local rendering dependencies

- `three.module.js`: Three.js **0.160.1**, copied from `three/build/three.module.js`.
- `RGBELoader.js`: the same version's `examples/jsm/loaders/RGBELoader.js`, with its
  `three` import changed to `./three.module.js` for direct local loading.
- `three-LICENSE.txt`: Three.js's MIT license.
- `three-addons/`: the same version's `GLTFLoader`, `OrbitControls`, and
  `BufferGeometryUtils`, used by the image/mesh alternatives viewer. An import
  map resolves their `three` imports to the local module.
- `meshopt_decoder.mjs`: meshoptimizer **1.2.0**, with its MIT license in
  `meshopt-LICENSE.md`, decodes the compressed alternative-part quick views.

The exact npm dependency is pinned in `package.json` and `package-lock.json`.
These files are bundled so opening the Python-served viewer needs neither npm
nor a CDN. Only K1's studio material view loads the physical renderer; the other
assets and hierarchy/assembly views retain the original renderer.
