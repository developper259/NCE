const {OpenAICompatibleAdapter}=require('../openai-compatible/OpenAICompatibleAdapter');
class OpenAIAdapter extends OpenAICompatibleAdapter{constructor(name,c={}){super(name,{baseUrl:'https://api.openai.com/v1',apiKeyEnv:'OPENAI_API_KEY',...c})}}
module.exports={OpenAIAdapter};
