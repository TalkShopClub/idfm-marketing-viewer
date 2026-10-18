import * as THREE from 'three';
import { GLTFLoader } from './vendor/three-addons/loaders/GLTFLoader.js';
import { OrbitControls } from './vendor/three-addons/controls/OrbitControls.js';
import { MeshoptDecoder } from './vendor/meshopt_decoder.mjs';

const $ = id => document.getElementById(id);
const embedded = window.parent !== window && new URLSearchParams(location.search).get('embed') === '1';
let viewerVisible = true;
const state = { parts: [], part: null, item: null, model: null, serial: 0, loadedVersion: null, busy: false };
const meshCache = new Map();
const meshLoads = new Map();
const CACHE_BYTES = 320 * 1048576;
let galleryLoading = false;
let warmTarget;
const canvas = $('mesh-canvas');
let renderer, controls, camera, scene;
const loader = new GLTFLoader();
loader.setMeshoptDecoder(MeshoptDecoder);
const formatMB = bytes => `${(bytes / 1048576).toFixed(1)} MB`;
const number = value => String(value).padStart(2, '0');
const meshKey = item => item ? `${item.mesh}?v=${item.mesh_version}` : '';
const previewKey = item => item ? `${item.preview}?v=${item.preview_version}` : '';

// IndexedDB also works on the cluster's plain-HTTP hostname. Keep at most 1 GiB
// on disk, and a much smaller set of parsed meshes in memory.
const diskCache = new Promise(resolve => {
  try {
    const request = indexedDB.open('idfm-alternative-meshes', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('meshes', { keyPath: 'key' });
    request.onsuccess = () => resolve(request.result);
    request.onerror = request.onblocked = () => resolve(null);
  } catch { resolve(null); }
});

async function readDiskCache(key) {
  const db = await diskCache;
  if (!db) return null;
  return new Promise(resolve => {
    try {
      const transaction = db.transaction('meshes', 'readwrite');
      const store = transaction.objectStore('meshes');
      const request = store.get(key);
      request.onsuccess = () => {
        const entry = request.result;
        if (entry) { entry.used = Date.now(); store.put(entry); }
        resolve(entry?.blob || null);
      };
      request.onerror = transaction.onabort = () => resolve(null);
    } catch { resolve(null); }
  });
}

async function writeDiskCache(key, bytes) {
  const db = await diskCache;
  if (!db) return;
  try {
    const transaction = db.transaction('meshes', 'readwrite');
    const store = transaction.objectStore('meshes');
    store.put({ key, blob: new Blob([bytes], { type: 'model/gltf-binary' }), size: bytes.byteLength, used: Date.now(), preview: key.includes('/mesh-previews/') });
    const request = store.getAll();
    request.onsuccess = () => {
      const entries = request.result.sort((a, b) => Number(a.preview || false) - Number(b.preview || false) || a.used - b.used);
      let size = entries.reduce((sum, entry) => sum + entry.size, 0);
      for (const entry of entries) {
        if (size <= 1073741824) break;
        store.delete(entry.key);
        size -= entry.size;
      }
    };
    // Quota/private-mode failures must never prevent displaying the mesh.
    transaction.onerror = () => {};
  } catch { /* Browser storage is optional. */ }
}

function showOverlay(message, detail = '', loading = false, retry = false) {
  $('mesh-overlay').hidden = false;
  $('mesh-message').textContent = message;
  $('mesh-detail').textContent = detail;
  $('loading-symbol').hidden = !loading;
  $('retry').hidden = !retry;
  $('view-tools').hidden = true;
}

function initialize3D() {
  try {
    renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 0.8;
    scene = new THREE.Scene();
    scene.background = new THREE.Color('#101216');
    camera = new THREE.PerspectiveCamera(36, 1, 0.001, 100);
    camera.up.set(0, 0, 1);
    controls = new OrbitControls(camera, canvas);
    controls.enableDamping = !matchMedia('(prefers-reduced-motion: reduce)').matches;
    controls.dampingFactor = 0.12;
    controls.autoRotateSpeed = 0.7;
    controls.screenSpacePanning = true;
    scene.add(new THREE.AmbientLight(0xffffff, 0.4));
    for (const [position, intensity, color] of [
      [[3, -4, 5], 2.0, 0xfff4e4], [[-4, -1, 2], 0.6, 0xdde8ff], [[0, 4, 4], 1.0, 0xffffff],
    ]) {
      const light = new THREE.DirectionalLight(color, intensity);
      light.position.set(...position);
      scene.add(light);
    }
    controls.addEventListener('change', render);
    new ResizeObserver(resize).observe($('mesh-stage'));
    let previous = performance.now();
    function animate(now) {
      requestAnimationFrame(animate);
      const delta = Math.min((now - previous) / 1000, 0.1);
      previous = now;
      if (state.model && viewerVisible && !document.hidden) controls.update(delta);
    }
    requestAnimationFrame(animate);
    canvas.addEventListener('webglcontextlost', event => {
      event.preventDefault();
      showOverlay('The 3D view was interrupted', 'Reload the page to restore the view. Your mesh is still available to download.');
    });
  } catch (error) {
    console.error(error);
    renderer = null;
    showOverlay('3D rendering is unavailable', 'Open this page in a browser with WebGL enabled. You can still download the mesh.');
  }
}

function render() { if (renderer && viewerVisible) renderer.render(scene, camera); }
function resize() {
  if (!renderer) return;
  const { width, height } = $('mesh-stage').getBoundingClientRect();
  if (!width || !height) return;
  renderer.setSize(width, height, false);
  camera.aspect = width / height;
  camera.updateProjectionMatrix();
  render();
}

function disposeModel(model) {
  if (!model) return;
  const resources = new Set();
  model.traverse(object => {
    if (object.geometry) resources.add(object.geometry);
    for (const material of [].concat(object.material || [])) {
      resources.add(material);
      for (const value of Object.values(material)) if (value?.isTexture) resources.add(value);
    }
  });
  for (const resource of resources) resource.dispose();
  model.removeFromParent();
}

function resetView() {
  if (!state.model) return;
  const box = new THREE.Box3().setFromObject(state.model);
  const sphere = box.getBoundingSphere(new THREE.Sphere());
  const radius = Math.max(sphere.radius, 0.001);
  const vertical = THREE.MathUtils.degToRad(camera.fov / 2);
  const horizontal = Math.atan(Math.tan(vertical) * camera.aspect);
  const distance = radius / Math.sin(Math.min(vertical, horizontal)) * 1.08;
  controls.target.copy(sphere.center);
  camera.position.copy(sphere.center).add(new THREE.Vector3(1.5, -1.8, 1.2).normalize().multiplyScalar(distance));
  camera.near = radius / 1000;
  camera.far = radius * 100;
  camera.updateProjectionMatrix();
  controls.minDistance = radius * 0.08;
  controls.maxDistance = radius * 25;
  controls.update();
  controls.saveState();
  render();
}

function trimCache() {
  const full = [...meshCache.values()].filter(entry => !entry.preview);
  let bytes = full.reduce((sum, entry) => sum + entry.bytes, 0);
  let count = full.length;
  for (const [key, entry] of meshCache) {
    if (count <= 3 && bytes <= CACHE_BYTES) break;
    if (entry.preview || entry.model === state.model || key === meshKey(state.item)) continue;
    disposeModel(entry.model);
    meshCache.delete(key);
    bytes -= entry.bytes;
    count--;
  }
}

async function meshBytes(url, signal, background) {
  const response = await fetch(url, { signal, cache: 'force-cache', priority: background ? 'low' : 'high' });
  if (!response.ok) throw new Error(`Download failed (${response.status})`);
  const total = Number(response.headers.get('X-Uncompressed-Length') || response.headers.get('Content-Length'));
  if (!response.body || !total) return response.arrayBuffer();
  const result = new Uint8Array(total);
  const reader = response.body.getReader();
  let offset = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    result.set(value, offset);
    offset += value.length;
    if (url === previewKey(state.item) || url === meshKey(state.item)) $('mesh-detail').textContent = `${formatMB(offset)} of ${formatMB(total)}`;
  }
  if (offset !== total) throw new Error('The mesh download was incomplete');
  return result.buffer;
}

function requestMesh(item, background = false, preview = true) {
  const key = preview ? previewKey(item) : meshKey(item);
  if (meshCache.has(key)) {
    const entry = meshCache.get(key);
    meshCache.delete(key);
    meshCache.set(key, entry);
    return Promise.resolve(entry);
  }
  const existing = meshLoads.get(key);
  if (existing && !existing.controller.signal.aborted) return existing.promise;
  const controller = new AbortController();
  const promise = (async () => {
    const stored = await readDiskCache(key);
    if (controller.signal.aborted) throw new DOMException('Mesh load cancelled', 'AbortError');
    const bytes = stored ? await stored.arrayBuffer() : await meshBytes(key, controller.signal, background);
    if (!stored) writeDiskCache(key, bytes);
    if (!background && preview && key === previewKey(state.item)) {
      $('mesh-message').textContent = 'Preparing 3D view';
      $('mesh-detail').textContent = 'Preparing the quick view…';
    }
    const gltf = await loader.parseAsync(bytes, '');
    if (controller.signal.aborted) {
      disposeModel(gltf.scene);
      throw new DOMException('Mesh load cancelled', 'AbortError');
    }
    let triangles = 0;
    gltf.scene.traverse(object => {
      if (object.isMesh) {
        triangles += (object.geometry.index?.count || object.geometry.attributes.position.count) / 3;
        object.geometry.computeBoundingBox();
      }
    });
    const entry = { model: gltf.scene, triangles, preview, bytes: preview ? item.preview_bytes : item.mesh_bytes };
    if (preview) warmPreview(entry);
    meshCache.set(key, entry);
    trimCache();
    return entry;
  })().finally(() => {
    if (meshLoads.get(key)?.controller === controller) meshLoads.delete(key);
  });
  meshLoads.set(key, { promise, controller });
  return promise;
}

function warmPreview(entry) {
  if (!renderer) return;
  warmTarget ||= new THREE.WebGLRenderTarget(1, 1);
  const previousTarget = renderer.getRenderTarget();
  const current = state.model;
  const visibility = current?.visible;
  if (current) current.visible = false;
  entry.model.traverse(object => { if (object.isMesh) object.frustumCulled = false; });
  scene.add(entry.model);
  renderer.setRenderTarget(warmTarget);
  renderer.render(scene, camera);
  renderer.setRenderTarget(previousTarget);
  entry.model.removeFromParent();
  entry.model.traverse(object => { if (object.isMesh) object.frustumCulled = true; });
  if (current) current.visible = visibility;
}

function galleryStatus() {
  const items = state.parts.flatMap(part => part.alternatives);
  const ready = items.filter(item => meshCache.has(previewKey(item))).length;
  $('collection-status').textContent = ready === items.length
    ? `All ${ready} quick views ready` : `Preparing quick views · ${ready} / ${items.length}`;
  $('collection-status').dataset.ready = String(ready);
}

async function preloadGallery() {
  if (galleryLoading || !renderer) return;
  const valid = new Set(state.parts.flatMap(part => part.alternatives).map(previewKey));
  for (const [key, entry] of meshCache) {
    if (entry.preview && !valid.has(key) && entry.model !== state.model) {
      disposeModel(entry.model);
      meshCache.delete(key);
    }
  }
  const parts = [...state.parts].sort((a, b) => Number(b.id === state.part?.id) - Number(a.id === state.part?.id));
  const queue = parts.flatMap(part => part.alternatives).filter(item => item.preview_ready && !meshCache.has(previewKey(item)));
  galleryStatus();
  if (!queue.length) return;
  galleryLoading = true;
  async function worker() {
    while (queue.length) {
      const item = queue.shift();
      try { await requestMesh(item, true); }
      catch (error) { console.warn('Quick view will retry when selected:', error.message); }
      galleryStatus();
      await new Promise(resolve => setTimeout(resolve, 0));
    }
  }
  try { await Promise.all([worker(), worker(), worker()]); }
  finally { galleryLoading = false; galleryStatus(); }
}

function displayMesh(entry, reset = true) {
  state.model?.removeFromParent();
  state.model = entry.model;
  scene.add(state.model);
  if (reset) resetView();
  else render();
  $('mesh-overlay').hidden = true;
  $('view-tools').hidden = false;
  $('full-detail').disabled = false;
  $('full-detail').textContent = entry.preview ? 'Full detail' : 'Quick view';
  $('mesh-badge').textContent = entry.preview ? 'Quick view' : 'Full detail';
  const count = entry.preview ? `${Math.round(entry.triangles / 1000)}K` : `${(entry.triangles / 1000000).toFixed(2)}M`;
  $('mesh-info').textContent = `${entry.preview ? 'Quick view' : 'Full refined mesh'} · ${count} triangles${entry.preview ? ' · Full-resolution GLB available' : ` · ${formatMB(entry.bytes)}`}`;
  canvas.dataset.loaded = `${state.part.id}/${state.item.id}`;
  canvas.dataset.quality = entry.preview ? 'preview' : 'full';
}

async function loadMesh() {
  const item = state.item;
  const key = meshKey(item);
  for (const [loadingKey, task] of meshLoads) if (!loadingKey.includes('/mesh-previews/') && loadingKey !== key) task.controller.abort();
  const serial = ++state.serial;
  state.loadedVersion = null;
  state.busy = false;
  if (renderer) {
    controls.autoRotate = false;
  }
  $('auto-rotate').setAttribute('aria-pressed', 'false');
  $('mesh-badge').classList.toggle('ready', item.mesh_ready);
  $('mesh-badge').textContent = item.mesh_ready ? 'Ready' : 'Pending';
  $('download-mesh').setAttribute('aria-disabled', String(!item.mesh_ready));
  if (item.mesh_ready) $('download-mesh').href = key;
  else $('download-mesh').removeAttribute('href');
  if (!renderer) return;
  if (!item.mesh_ready) {
    state.model?.removeFromParent();
    state.model = null;
    render();
    showOverlay('Mesh is being generated', 'It will appear here automatically when it is ready.');
    return;
  }
  const cached = meshCache.get(previewKey(item));
  if (cached) {
    displayMesh(cached);
    preloadGallery();
    return;
  }
  state.model?.removeFromParent();
  state.model = null;
  render();
  if (!item.preview_ready) {
    showOverlay('Preparing the quick view', 'You can download the full refined mesh above.');
    return;
  }
  state.busy = true;
  showOverlay('Preparing quick view', formatMB(item.preview_bytes), true);
  try {
    const entry = await requestMesh(item);
    if (serial !== state.serial) return;
    state.loadedVersion = item.mesh_version;
    displayMesh(entry);
  } catch (error) {
    if (serial !== state.serial || error.name === 'AbortError') return;
    console.error(error);
    showOverlay('Could not load this mesh', error.message, false, true);
  } finally {
    if (serial === state.serial) { state.busy = false; preloadGallery(); }
  }
}

async function toggleFullDetail() {
  if (!state.item) return;
  if (canvas.dataset.quality === 'full') { displayMesh(meshCache.get(previewKey(state.item)), false); return; }
  const serial = state.serial;
  $('full-detail').disabled = true;
  $('full-detail').textContent = 'Loading full detail…';
  try {
    const entry = await requestMesh(state.item, true, false);
    if (serial === state.serial) displayMesh(entry, false);
  } catch (error) {
    if (serial !== state.serial) return;
    $('full-detail').disabled = false;
    $('full-detail').textContent = 'Retry full detail';
    $('mesh-info').textContent = 'Quick view · Full detail could not load. You can retry or download the GLB.';
  }
}

function updateList() {
  const part = state.part;
  $('part-count').textContent = part.alternatives.length;
  $('alternatives').replaceChildren(...part.alternatives.map(item => {
    const button = document.createElement('button');
    button.className = 'alternative';
    button.setAttribute('aria-current', String(item.id === state.item?.id));
    button.setAttribute('aria-label', `Alternative ${number(item.number)}, mesh ${item.mesh_ready ? 'ready' : 'pending'}`);
    const image = new Image();
    image.src = item.image;
    image.alt = '';
    image.loading = 'lazy';
    const label = document.createElement('span');
    label.className = 'alternative-label';
    label.textContent = `Alternative ${number(item.number)}`;
    const status = document.createElement('span');
    status.className = `alternative-status${item.mesh_ready ? ' ready' : ''}`;
    status.textContent = item.mesh_ready ? 'Mesh ready' : 'Mesh pending';
    label.append(status);
    button.append(image, label);
    button.addEventListener('click', () => select(part.id, item.id));
    return button;
  }));
}

function notifyParent() {
  if (embedded && state.part && state.item) window.parent.postMessage({
    type: 'idfm-part-selection', part: state.part.id, item: state.item.id,
  }, location.origin);
}

function select(partId, itemId, updateHash = true) {
  const part = state.parts.find(part => part.id === partId) || state.parts[0];
  const item = part?.alternatives.find(item => item.id === itemId) || part?.alternatives[0];
  if (!item) { showOverlay('No alternative images found'); return; }
  if (state.part?.id === part.id && state.item?.id === item.id) { notifyParent(); return; }
  state.part = part;
  state.item = item;
  $('part-select').value = part.id;
  $('part-title').textContent = part.label;
  $('selection-title').textContent = `Alternative ${number(item.number)}`;
  document.title = `${part.label} · Alternative ${number(item.number)} · IDFM`;
  $('reference').src = item.image;
  $('reference').alt = `${part.label}, generated alternative ${number(item.number)}`;
  $('reference').hidden = false;
  $('download-image').href = item.image;
  const index = part.alternatives.indexOf(item);
  $('previous').disabled = index === 0;
  $('next').disabled = index === part.alternatives.length - 1;
  delete canvas.dataset.loaded;
  updateList();
  if (updateHash) history.replaceState(null, '', `#${part.id}/${item.id}`);
  notifyParent();
  loadMesh();
}

async function refresh() {
  try {
    const response = await fetch('alternatives.json', { cache: 'no-store' });
    if (!response.ok) throw new Error(`Collection request failed (${response.status})`);
    const { parts } = await response.json();
    state.parts = parts;
    const all = parts.flatMap(part => part.alternatives);
    const ready = all.filter(item => item.mesh_ready).length;
    $('completion').textContent = `${ready} / ${all.length} meshes ready`;
    if (!state.part) {
      $('part-select').replaceChildren(...parts.map(part => new Option(part.label, part.id)));
      $('part-select').disabled = false;
      const [partId, itemId] = location.hash.slice(1).split('/');
      select(partId, itemId);
    } else {
      const part = parts.find(part => part.id === state.part.id);
      const item = part?.alternatives.find(item => item.id === state.item.id);
      if (!item) { select(parts[0]?.id); return; }
      const becameReady = (!state.item.mesh_ready && item.mesh_ready) || (!state.item.preview_ready && item.preview_ready);
      const changed = state.item.mesh_version !== item.mesh_version;
      const previewChanged = state.item.preview_version !== item.preview_version && canvas.dataset.quality !== 'full';
      const listChanged = part.alternatives.some((item, i) => item.mesh_ready !== state.part.alternatives[i]?.mesh_ready);
      state.part = part;
      state.item = item;
      if (listChanged) updateList();
      if (becameReady || ((changed || previewChanged) && !state.busy)) loadMesh();
      else if (!state.busy) preloadGallery();
    }
  } catch (error) {
    $('collection-status').textContent = 'Collection update unavailable. Retrying shortly.';
    if (!state.part) showOverlay('Could not load the collection', 'Check the server connection. This page will retry automatically.');
    console.error(error);
  }
}

function step(direction) {
  if (!state.part) return;
  const items = state.part.alternatives;
  const index = items.findIndex(item => item.id === state.item.id) + direction;
  if (items[index]) select(state.part.id, items[index].id);
}
$('part-select').addEventListener('change', event => select(event.target.value));
$('previous').addEventListener('click', () => step(-1));
$('next').addEventListener('click', () => step(1));
$('reset-view').addEventListener('click', resetView);
$('retry').addEventListener('click', loadMesh);
$('full-detail').addEventListener('click', toggleFullDetail);
$('auto-rotate').addEventListener('click', () => {
  if (!controls) return;
  controls.autoRotate = !controls.autoRotate;
  $('auto-rotate').setAttribute('aria-pressed', String(controls.autoRotate));
});
document.addEventListener('keydown', event => {
  if (['SELECT', 'INPUT', 'TEXTAREA'].includes(event.target.tagName)) return;
  if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') { event.preventDefault(); step(event.key === 'ArrowLeft' ? -1 : 1); }
});
window.addEventListener('hashchange', () => select(...location.hash.slice(1).split('/'), false));
window.addEventListener('message', event => {
  if (!embedded || event.origin !== location.origin || event.source !== window.parent) return;
  if (event.data?.type === 'idfm-visibility') {
    viewerVisible = Boolean(event.data.visible);
    if (viewerVisible) { resize(); preloadGallery(); }
  } else if (event.data?.type === 'idfm-select-part') {
    const { part, item } = event.data;
    if (state.parts.length) select(part, item);
    else history.replaceState(null, '', `#${encodeURIComponent(part || '')}/${encodeURIComponent(item || '')}`);
  }
});
initialize3D();
refresh();
setInterval(refresh, 12000);
