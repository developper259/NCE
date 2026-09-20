class ProviderRegistry { constructor(definitions = {}) { this.providers = new Map(Object.entries(definitions)); } get(id) { const p=this.providers.get(id); if(!p) throw new Error(`Unknown provider: ${id}`); return {id,...p}; } has(id){return this.providers.has(id);} }
module.exports={ProviderRegistry};
