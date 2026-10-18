import * as THREE from './vendor/three.module.js';
import {RGBELoader} from './vendor/RGBELoader.js';

const srgb = rgb => new THREE.Color().setRGB(...rgb, THREE.SRGBColorSpace);

// Small, deterministic material maps. UVs are generated from the actual CAD
// coordinates; no screenshot texture is painted over the geometry.
function surfaceTexture(kind) {
  const size = 256, data = new Uint8Array(size * size * 4);
  let seed = 173;
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    const grain = (seed >>> 24) / 255;
    let h = .5 + (grain - .5) * .28;
    if (kind === 'carbon') {
      const crossing = (Math.floor(x/16) + Math.floor(y/16)) % 2;
      h = .4 + .18 * Math.sin((crossing ? x : y) * Math.PI/8) + .05 * grain;
    }
    if (kind === 'leather') h = .35 + .25 * grain + .12 * Math.sin(x*.4) * Math.sin(y*.5);
    if (kind === 'tire') {
      const u=x/size,v=y/size,band=v>.17&&v<.83;
      const longitudinal=Math.abs(Math.sin(v*Math.PI*7))<.18;
      const chevron=Math.abs(Math.sin((u*38+Math.abs(v-.5)*5)*Math.PI))<.19;
      h = .65 + .06*grain - (band && (longitudinal||chevron) ? .48 : 0);
    }
    if (kind === 'brushed') h = .45 + .10 * Math.sin(y * 4) + .05 * grain;
    const i = (y * size + x) * 4, value = Math.round(h * 255);
    data.set([value, value, value, 255], i);
  }
  const t = new THREE.DataTexture(data, size, size);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.magFilter = THREE.LinearFilter; t.minFilter = THREE.LinearMipmapLinearFilter;
  t.generateMipmaps = true; t.needsUpdate = true;
  return t;
}

export class AutomotiveRenderer {
  static async create(canvas, context) {
    const view = new AutomotiveRenderer(canvas, context);
    const hdr = await new RGBELoader().loadAsync('environment/studio_small_09_1k.hdr');
    const pmrem = new THREE.PMREMGenerator(view.renderer);
    view.environment = pmrem.fromEquirectangular(hdr);
    view.scene.environment = view.environment.texture;
    hdr.dispose(); pmrem.dispose(); view.renderer.resetState();
    return view;
  }

  constructor(canvas, context) {
    this.canvas = canvas;
    this.renderer = new THREE.WebGLRenderer({canvas, context, antialias: true, alpha: true});
    this.renderer.debug.onShaderError = (gl, program, vertex, fragment) => {throw Error('Material shader failed: '+gl.getShaderInfoLog(fragment))};
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = .82;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.renderer.shadowMap.autoUpdate = false;
    this.renderer.setClearColor(0x15171b, 1);
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera();
    this.camera.matrixAutoUpdate = false;
    this.uniforms = {cadCenter: {value: new THREE.Vector3()}, cadScale: {value: 1}, cadExplode: {value: 0}, cadFocus: {value: 0}};
    this.textures = Object.fromEntries(['grain','carbon','leather','brushed','tire'].map(k => [k, surfaceTexture(k)]));
    const key = new THREE.DirectionalLight(0xfff1df, 1.6);
    key.position.set(-1.5, 2.5, 1.5); key.castShadow = true;
    key.shadow.mapSize.set(2048, 2048);
    Object.assign(key.shadow.camera, {left: -.9, right: .9, top: .9, bottom: -.9, near: .1, far: 6});
    key.shadow.radius = 3;
    key.shadow.bias = -.00006; key.shadow.normalBias = .0002;
    this.scene.add(key, new THREE.HemisphereLight(0xd5eaff, 0x282523, .35));
    const rim = new THREE.DirectionalLight(0xcddfff, .65); rim.position.set(2, 1, -2); this.scene.add(rim);
    this.ground = new THREE.Mesh(new THREE.PlaneGeometry(3,3), new THREE.ShadowMaterial({opacity: .26}));
    this.ground.rotation.x = -Math.PI/2; this.ground.receiveShadow = true;
    this.scene.add(this.ground);
  }

  shader(material, shadow=false) {
    material.onBeforeCompile = shader => {
      Object.assign(shader.uniforms, this.uniforms);
      shader.vertexShader = 'attribute vec3 cadOffset; attribute float cadVisible, cadGlass; varying float visibility,glassSurface; uniform vec3 cadCenter; uniform float cadScale,cadExplode;\n' + shader.vertexShader;
      shader.vertexShader = shader.vertexShader.replace('#include <begin_vertex>',
        'vec3 transformed = (position-cadCenter)*cadScale+cadOffset*cadExplode; visibility=cadVisible;glassSurface=cadGlass;');
      shader.fragmentShader = 'varying float visibility,glassSurface; uniform float cadFocus;\n' + shader.fragmentShader;
      shader.fragmentShader = shader.fragmentShader.replace('void main() {', 'void main() { if(visibility < -.5'+(shadow?' || glassSurface > .5':'')+') discard;');
      if(!shadow)shader.fragmentShader=shader.fragmentShader.replace('#include <opaque_fragment>', `
        if(cadFocus>.5){
          float focusLight=.52+.48*max(dot(normal,normalize(vec3(.3,.7,1.))),0.);
          outgoingLight=(visibility>1.5?vec3(1.0,.53,.035):vec3(.19,.24,.30))*focusLight;
          diffuseColor.a=1.0;
        }
        #include <opaque_fragment>`);
    };
    material.customProgramCacheKey = () => 'k1-cad-focus-v3-'+shadow;
    return material;
  }

  clear() {
    if (!this.model) return;
    this.scene.remove(this.model); this.geometry.dispose();
    this.materials.forEach(m => m.dispose()); this.model.customDepthMaterial.dispose();
    this.model = null; this.variant = null;
  }

  setModel(positions, normals, faces, atomic, metadata, materials) {
    this.clear(); this.definition = materials;
    this.roles = Object.keys(materials.palette);
    const roleIndex = new Map(this.roles.map((r,i) => [r,i]));
    this.vertexRole = Uint8Array.from(atomic, a => roleIndex.get(materials.atomic_materials[a]));
    for (const s of materials.surface_materials || []) this.vertexRole.fill(roleIndex.get(s.material), s.start, s.start+s.count);
    const counts = new Uint32Array(this.roles.length);
    for (let f = 0; f < faces.length; f += 3) counts[this.vertexRole[faces[f]]] += 3;
    const offsets = new Uint32Array(counts.length);
    for (let i = 1; i < counts.length; i++) offsets[i] = offsets[i-1]+counts[i-1];
    const cursor = offsets.slice(), indices = new Uint32Array(faces.length);
    for (let f = 0; f < faces.length; f += 3) {
      const role = this.vertexRole[faces[f]], start = cursor[role];
      indices[start]=faces[f]; indices[start+1]=faces[f+1]; indices[start+2]=faces[f+2]; cursor[role]+=3;
    }
    this.geometry = new THREE.BufferGeometry();
    this.geometry.setAttribute('position', new THREE.BufferAttribute(positions,3));
    this.geometry.setAttribute('normal', new THREE.BufferAttribute(normals,3));
    this.geometry.setAttribute('cadOffset', new THREE.BufferAttribute(new Float32Array(positions.length),3));
    this.geometry.setAttribute('cadGlass', new THREE.BufferAttribute(Uint8Array.from(this.vertexRole,r=>this.roles[r]==='glass'?1:0),1));
    this.geometry.setAttribute('cadVisible', new THREE.BufferAttribute(new Float32Array(atomic.length).fill(1),1));
    const uv = new Float32Array(atomic.length*2), tireBounds = new Map();
    for(let i=0;i<atomic.length;i++) if(this.roles[this.vertexRole[i]]==='tire') {
      if(!tireBounds.has(atomic[i]))tireBounds.set(atomic[i],[Infinity,Infinity,Infinity,-Infinity,-Infinity,-Infinity]);
      const b=tireBounds.get(atomic[i]);for(let k=0;k<3;k++){b[k]=Math.min(b[k],positions[i*3+k]);b[k+3]=Math.max(b[k+3],positions[i*3+k])}
    }
    for (let i=0; i<atomic.length; i++) {
      // Grain and weave are at millimetre scale in the normalized CAD frame.
      uv[i*2] = (positions[i*3] + positions[i*3+2]) * 42;
      uv[i*2+1] = (positions[i*3+1] + positions[i*3+2]) * 42;
      const b=tireBounds.get(atomic[i]);
      if(b){
        const y=positions[i*3+1]-(b[1]+b[4])/2,z=positions[i*3+2]-(b[2]+b[5])/2;
        uv[i*2]=Math.atan2(y,z)/(Math.PI*2)+.5;
        uv[i*2+1]=Math.abs(normals[i*3])>.65 ? .06 : .17+.66*(positions[i*3]-b[0])/(b[3]-b[0]);
      }
    }
    this.geometry.setAttribute('uv', new THREE.BufferAttribute(uv,2));
    this.geometry.setIndex(new THREE.BufferAttribute(indices,1));
    counts.forEach((count,i) => {if(count) this.geometry.addGroup(offsets[i],count,i)});
    this.materials = this.roles.map(role => this.makeMaterial(role, materials.palette[role]));
    this.model = new THREE.Mesh(this.geometry, this.materials);
    this.model.frustumCulled = false; this.model.castShadow = true; this.model.receiveShadow = true;
    this.model.customDepthMaterial = this.shader(new THREE.MeshDepthMaterial({depthPacking: THREE.RGBADepthPacking}),true);
    this.scene.add(this.model);
    this.geometry.computeBoundingBox(); this.ground.position.y = this.geometry.boundingBox.min.y-.001;
    this.renderer.shadowMap.needsUpdate = true;
    this.renderer.resetState();
  }

  makeMaterial(role, definition) {
    const p = definition.pbr || {};
    const material = new THREE.MeshPhysicalMaterial({color: srgb(definition.color),
      metalness: definition.metalness, roughness: definition.roughness,
      envMapIntensity: 1.3, side: role === 'glass' ? THREE.FrontSide : THREE.DoubleSide,
      ...p});
    if (p.attenuationColor) material.attenuationColor = new THREE.Color(p.attenuationColor);
    if (p.emissive) material.emissive = new THREE.Color(p.emissive);
    const kind = role==='tire'?'tire':role==='carbon'?'carbon':role==='interior'||role==='leather'?'leather':role==='alloy'||role==='wheel'?'brushed':'grain';
    if (role!=='glass' && !role.includes('light')) {
      material.bumpMap = this.textures[kind];
      material.bumpScale = role==='tire' ? .00012 : role==='body' ? .0000015 : kind==='leather' ? .000035 : .00001;
    }
    return this.shader(material);
  }

  setVariant(name) {
    if (name===this.variant || !this.model) return;
    const palette = this.definition.variants[name].palette;
    this.materials.forEach(m => m.dispose());
    this.materials = this.roles.map(role => this.makeMaterial(role, palette[role]));
    this.model.material = this.materials; this.variant = name;
  }

  updateAttribute(name, values, size) {
    if (!this.model) return;
    const a = this.geometry.getAttribute(name);
    a.array.set(values); a.needsUpdate = true;
    this.renderer.shadowMap.needsUpdate = true;
  }

  draw(matrices, fit, explode, variant, whole, focus=false) {
    if (!this.model) return;
    this.renderer.resetState(); this.setVariant(variant);
    const r = this.canvas.getBoundingClientRect();
    const ratio = Math.min(window.devicePixelRatio || 1, 2);
    this.renderer.setPixelRatio(ratio); this.renderer.setSize(r.width,r.height,false);
    this.camera.matrixWorldInverse.fromArray(matrices.mv);
    this.camera.matrixWorld.copy(this.camera.matrixWorldInverse).invert();
    this.camera.matrix.copy(this.camera.matrixWorld);
    this.camera.projectionMatrix.fromArray(matrices.mvp).multiply(this.camera.matrixWorld);
    this.camera.isOrthographicCamera = Math.abs(this.camera.projectionMatrix.elements[15]-1)<1e-6;
    this.camera.isPerspectiveCamera = !this.camera.isOrthographicCamera;
    this.camera.projectionMatrixInverse.copy(this.camera.projectionMatrix).invert();
    this.camera.near = .05; this.camera.far = 50;
    this.uniforms.cadCenter.value.fromArray(fit.cen);
    this.uniforms.cadScale.value = fit.sc; this.uniforms.cadExplode.value = explode;
    this.uniforms.cadFocus.value = focus ? 1 : 0;
    this.ground.visible = whole && explode===0;
    this.renderer.render(this.scene,this.camera);
    this.renderer.resetState();
  }
}
