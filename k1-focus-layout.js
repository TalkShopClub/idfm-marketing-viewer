/* Rigid assembly translations in the original K1 coordinates; no geometry is scaled. */
(function(root) {
  function boundsFor(atomics, bounds) {
    const lo=[Infinity,Infinity,Infinity],hi=[-Infinity,-Infinity,-Infinity];
    for(const a of atomics)for(let k=0;k<3;k++){lo[k]=Math.min(lo[k],bounds[a][k]);hi[k]=Math.max(hi[k],bounds[a][k+3])}
    return {lo,hi,center:lo.map((v,k)=>(v+hi[k])/2)};
  }
  function build(meta,bounds,config,selectedId,materials) {
    const nodes=meta.author.byId,assigned=new Set(),groups=[];
    const offsets=Array.from({length:meta.atomic_names.length},()=>[0,0,0]);
    function add(id,atomics,delta) {
      atomics=atomics.filter(a=>!assigned.has(a));if(!atomics.length)return;
      groups.push({id,atomics,delta});for(const a of atomics){assigned.add(a);offsets[a]=delta}
    }
    // Keep all four reviewed components intact, even when another is selected.
    for(const part of config.parts){
      const frame=part.id==='k1_structural_frame';
      const delta=frame?[0,0,0]:part.id===selectedId?[.48,.17,0]:[0,.10,0];
      add(part.id,part.atomics,delta);
    }
    function travel(atomics) {
      const b=boundsFor(atomics,bounds),[x,y,z]=b.center,roles={};let total=0;
      for(const a of atomics){const area=meta.atomic_area[a]||1;const role=materials.atomic_materials[a];roles[role]=(roles[role]||0)+area;total+=area}
      const fraction=(...names)=>names.reduce((s,name)=>s+(roles[name]||0),0)/total;
      if(fraction('tire','wheel')>.25||(Math.abs(x)>.14&&y<0&&Math.abs(z)>.2))return [Math.sign(x)*.24,-.015,Math.sign(z)*.07];
      if(fraction('body','glass')>.25){
        if(Math.abs(x)>.10&&b.hi[0]-b.lo[0]<.18)return [Math.sign(x)*.26,.12,0];
        return [0,.34,z*.2];
      }
      if(fraction('interior','leather')>.25)return [0,.21,0];
      if(Math.abs(x)>.09)return [Math.sign(x)*.22,0,Math.sign(z)*.06];
      if(Math.abs(z)>.34)return [0,.02,Math.sign(z)*.23];
      return [0,-.14,Math.sign(z)*.06];
    }
    function assembly(id) {
      const node=nodes[id],atomics=node.atomics.filter(a=>!assigned.has(a));if(!atomics.length)return;
      const b=boundsFor(atomics,bounds);
      // Split broad suspension parents at actual assembly boundaries, not per bolt.
      if(atomics.length>100&&b.hi[0]-b.lo[0]>.25&&node.children.length){
        node.children.forEach(assembly);
        const remaining=atomics.filter(a=>!assigned.has(a));if(remaining.length)add(id,remaining,travel(remaining));
      }else add(id,atomics,travel(atomics));
    }
    const frame=config.parts.find(p=>p.id==='k1_structural_frame');
    frame.excluded_node_ids.forEach(assembly);
    nodes[meta.author.root].children.forEach(assembly);
    const missing=meta.atomic_names.map((_,a)=>a).filter(a=>!assigned.has(a));
    if(missing.length)add('remaining',missing,[0,-.14,0]);
    return {offsets,groups};
  }
  function fit(layout,bounds,amount) {
    const lo=[Infinity,Infinity,Infinity],hi=[-Infinity,-Infinity,-Infinity];
    for(let a=0;a<bounds.length;a++)for(let k=0;k<3;k++){
      lo[k]=Math.min(lo[k],bounds[a][k]+layout.offsets[a][k]*amount);
      hi[k]=Math.max(hi[k],bounds[a][k+3]+layout.offsets[a][k]*amount);
    }
    return {cen:lo.map((v,k)=>(v+hi[k])/2),sc:1/Math.max(...hi.map((v,k)=>v-lo[k]),1e-6)};
  }
  const api={build,fit,boundsFor};
  if(typeof module==='object'&&module.exports)module.exports=api;else root.K1FocusLayout=api;
})(globalThis);
