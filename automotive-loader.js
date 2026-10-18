// Load the local PBR renderer only for assets with automotive materials.
let automotiveModule;
async function studioDeadline(promise) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(Error('Studio materials stopped loading. Check your connection and try again.')), 45000);
    })]);
  } finally {clearTimeout(timer)}
}
window.loadAutomotiveRenderer = async function(canvas, context) {
  automotiveModule ||= import('./automotive.js');
  const {AutomotiveRenderer} = await studioDeadline(automotiveModule);
  return studioDeadline(AutomotiveRenderer.create(canvas, context));
};
