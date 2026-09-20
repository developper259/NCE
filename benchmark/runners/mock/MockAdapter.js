const {BenchmarkModelAdapter}=require('../base/BenchmarkModelAdapter');
class MockAdapter extends BenchmarkModelAdapter{async complete(request){return {choices:[{message:{role:'assistant',content:'Mock framework response. No real model was evaluated.'}}],usage:{prompt_tokens:1,completion_tokens:1,total_tokens:2},mock:true}}}
module.exports={MockAdapter};
