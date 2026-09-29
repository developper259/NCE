class BenchmarkModelAdapter {
  constructor(name,config={}){this.name=name;this.config=config}
  async complete(){throw new Error('complete() must be implemented')}
  normalizeUsage(usage={}){return {input_tokens:usage.prompt_tokens??usage.input_tokens??0,output_tokens:usage.completion_tokens??usage.output_tokens??0,total_tokens:usage.total_tokens??((usage.input_tokens||0)+(usage.output_tokens||0))}}
}
module.exports={BenchmarkModelAdapter};
