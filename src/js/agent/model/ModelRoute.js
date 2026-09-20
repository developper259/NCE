class ModelRoute { constructor(candidates=[]){this.candidates=candidates.map(c=>({id:`${c.providerId}:${c.model}`,...c}));} at(i){return this.candidates[i]||null;} get length(){return this.candidates.length;} toJSON(){return this.candidates.map(({id,providerId,model})=>({id,providerId,model}));} }
module.exports={ModelRoute};
