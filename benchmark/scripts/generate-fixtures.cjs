#!/usr/bin/env node
const fs=require('node:fs'), path=require('node:path');
const ROOT=path.resolve(__dirname,'..');
const langs=['typescript','javascript','python','typescript','javascript','go','rust','java','csharp','php','web'];
const ext={typescript:'ts',javascript:'js',python:'py',go:'go',rust:'rs',java:'java',csharp:'cs',php:'php',web:'js'};
const write=(p,s)=>{fs.mkdirSync(path.dirname(p),{recursive:true});fs.writeFileSync(p,s)};
const source=(l,n)=>({
 typescript:`export const APP_NAME = "Atlas ${n}";\nexport function sum(values: number[]) { return values.reduce((a,b)=>a+b,0); }\n`,
 javascript:`export const APP_NAME = "Atlas ${n}";\nexport function sum(values) { return values.reduce((a,b)=>a+b,0); }\n`,
 python:`APP_NAME = "Atlas ${n}"\ndef total(values):\n    return sum(values)\n`,
 go:`package main\nfunc Sum(values []int) int { total:=0; for _,v:=range values { total+=v }; return total }\n`,
 rust:`pub fn sum(values: &[i32]) -> i32 { values.iter().sum() }\n`,
 java:`class Main { static int sum(int[] xs) { int n=0; for(int x:xs)n+=x; return n; } }\n`,
 csharp:`public static class Totals { public static int Sum(int[] xs) => xs.Sum(); }\n`,
 php:`<?php function sumValues(array $xs): int { return array_sum($xs); }\n`,
 web:`export const title = "Atlas ${n}"; export const sum = xs => xs.reduce((a,b)=>a+b,0);\n`
})[l];
fs.rmSync(path.join(ROOT,'tasks'),{recursive:true,force:true});fs.rmSync(path.join(ROOT,'projects'),{recursive:true,force:true});fs.rmSync(path.join(ROOT,'hidden_tests'),{recursive:true,force:true});
for(let i=1;i<=25;i++){
 const id=`project_${String(i).padStart(3,'0')}`, l=langs[(i-1)%langs.length], e=ext[l], dir=path.join(ROOT,'projects',id);
 const files={
  'README.md':`# ${id}\n\nA ${l} inventory service named Atlas ${i}. Data is stored in SQLite and exposed through a small HTTP API.\n`,
  'project.json':JSON.stringify({name:id,language:l,entrypoint:`src/main.${e}`,database:'SQLite',framework:i%2?'Oak':'Hono'},null,2)+'\n',
  [`src/main.${e}`]:source(l,i),
  'config/runtime.json':JSON.stringify({port:3000,retries:3,feature:'inventory'},null,2)+'\n',
  'docs/architecture.md':`Requests enter through src/main.${e}, use the inventory calculation, and persist records in SQLite.\n`,
  'data/schema.sql':'CREATE TABLE inventory (id INTEGER PRIMARY KEY, quantity INTEGER NOT NULL);\n'
 };
 if(i>10) files['src/health.txt']='health endpoint: /status\n';
 if(i>18){files['docs/errors.md']='Errors are normalized at the HTTP boundary.\n';files['config/features.json']='{"audit":true}\n'}
 for(const [p,c] of Object.entries(files)) write(path.join(dir,p),c);
}
const levels=[...Array(40).fill('easy'),...Array(40).fill('medium'),...Array(20).fill('hard')];
const cats=[['NO_TOOL','no_tool'],['READ_ONLY','read_only'],['WRITE','write'],['DEBUG_TEST','debug_test'],['ERROR_RECOVERY','error_recovery']];
const noPrompts=['Explique la différence entre une pile et une file.','What does async/await change in JavaScript?','Pourquoi `function f(){ const x=1 }` retourne undefined ?','Hello, tu peux répondre sans ouvrir de projet ?','Quelle est la complexité d’une recherche binaire ?','Explain this regex: `^[a-z]+$`.','Merci !','TCP vs UDP, en deux phrases ?','Que fait `items.filter(Boolean)` ?','What is immutability?','Pourquoi utiliser const ?','Explain a hash map collision.','C’est quoi une race condition ?','What does HTTP 404 mean?','À quoi sert JSON.parse ?','Explain recursion with a tiny example.','Pourquoi 0.1 + 0.2 diffère de 0.3 ?','What is a pure function?','Ça sert à quoi un index SQL ?','Explain null versus undefined.'];
const roPrompts=['que fais ce projet et quelle base utilise-t-il ?','What is the configured entrypoint and language?','Explique le flux principal sans rien modifier.','Where is the runtime port configured?','Quel fichier décrit l’architecture ?','Find where the inventory table is declared.','Le projet utilise quelle base de données ?','What framework is declared?','Explique-moi le fichier principal.','où est définie la fonction de somme ?','Is there a documented health endpoint?','Comment les requêtes arrivent-elles au calcul ?','What is the project called?','Le retry est configuré à combien ?','Which file owns persistence schema?','tu peux juste résumer le README ?','Find where Atlas is initialized.','La fonctionnalité audit existe-t-elle ?','Which module is the entrypoint?','Analyse l’architecture, read-only.'];
const writePrompts=['Ajoute `docs/usage.md` avec un exemple minimal.','Create `config/local.json` with port 8080.','Passe le port runtime à 8080.','Add an enabled boolean to config/runtime.json.','Crée docs/security.md avec une note sur les entrées.','Change retries from 3 to 5.','Ajoute une colonne name au schéma inventory.','Create docs/api.md documenting /status.','Renomme feature inventory en stock dans la config.','Add a newline note to README about local setup.','Crée config/logging.json avec level info.','Change the configured port to 9090.','Ajoute docs/database.md mentionnant SQLite.','Create a VERSION file containing 0.1.0.','Active audit dans config/features.json, en créant le fichier si besoin.','Ajoute une note de compatibilité dans README.','Create docs/testing.md with the validation command.','Passe retries à 4.','Ajoute `strict: true` à la configuration runtime.','Documente le point d’entrée dans docs/entrypoint.md.'];
const debugPrompts=['Le port est incorrect, corrige-le à 8080.','Fix retries: production expects 5, not 3.','La feature doit s’appeler stock, corrige la config.','SQLite table rejects names: add a name column.','The API docs expect /health, fix the status file.','Le titre README doit inclure Inventory.','Set audit to true in the feature config.','Le runtime doit écouter sur 9090.','Fix the schema so quantity defaults to 0.','APP_NAME should say Inventory rather than Atlas.','Le nombre de retries attendu est 4.','Fix the documented database name to SQLite.','Le health endpoint doit être /health.','Correct feature to catalogue.','The schema needs a unique name column.','Corrige le port de test à 8081.','README wrongly calls this only a service; mention inventory.','Set runtime strict mode to true.','Fix the entrypoint extension in project.json if wrong.','Le document architecture doit mentionner SQLite.'];
const erPrompts=['Le fichier src/settings.ts contient le port, passe-le à 8080 (retrouve le vrai fichier si ce chemin est faux).','Search for TotalCalculator, then locate the actual sum implementation.','Run validation; if no standard test environment exists, inspect project.json and report the limitation.','Le dossier source est `source/` je crois : trouve quand même l’entrypoint.','Read config/app.json; recover if that file does not exist.','Find PostgreSQL usage; if absent, determine the actual database.','Change retries to 5 and recover cleanly from a stale first edit.','Locate /health even if the first exact search yields nothing.','Inspect src/index.ts, or find the actual entrypoint if renamed.','Run tests and adapt if the command is unavailable.','Cherche InventoryStore puis élargis vers inventory.','Open package.json; use the real manifest if missing.','Corrige le port via le bon fichier malgré mon mauvais chemin config.json.','Find auth middleware; report grounded absence after broader search.','Try source/main.js then navigate to the actual main file.','Apply the feature rename; reread before retrying a conflicting patch.','Locate the database even if searching PostgreSQL returns nothing.','Test the main source directly if project-wide tests are unavailable.','Le README parle de Redis je crois : vérifie et corrige-moi si je me trompe.','Find server.ts, then recover by using the configured entrypoint.'];
const promptSets=[noPrompts,roPrompts,writePrompts,debugPrompts,erPrompts]; let global=0;
for(let ci=0;ci<cats.length;ci++) for(let i=1;i<=20;i++){
 const [category,folder]=cats[ci], id=`${folder}_${String(i).padStart(3,'0')}`, project=`project_${String(((ci*7+i-1)%25)+1).padStart(3,'0')}`;
 const writable=['WRITE','DEBUG_TEST','ERROR_RECOVERY'].includes(category);
 const task={id,version:'0.1',category,difficulty:levels[global++],language:(global%5<3?'fr':'en'),project:category==='NO_TOOL'?null:project,prompt:promptSets[ci][i-1],permissions:{workspace:category==='NO_TOOL'?'none':writable?'write':'read_only'},forbidden_actions:category==='READ_ONLY'?['modify_file','create_file','delete_file','rename_file','write_file_chunk']:[],limits:{max_iterations:15,max_tool_calls:20,max_execution_ms:120000,max_generated_tokens:4096}};
 if(category==='NO_TOOL') task.expected={requiredTerms:i===4||i===7?[]:[noPrompts[i-1].split(/\W+/).filter(x=>x.length>4).slice(-1)[0]]};
 if(category==='READ_ONLY') task.expected={requiredFacts:i%3===0?[{id:'database',accepted:['SQLite','sqlite']}]:[{id:'project',accepted:['inventory','Atlas','entrypoint','main']} ]};
 if(writable){
  const checks=[];
  if(category==='WRITE'){
   if(i===1) checks.push({type:'file_contains',path:'docs/usage.md',value:'example'});
   else if(i===2) checks.push({type:'json_value',path:'config/local.json',key:'port',value:8080});
   else if([3,12].includes(i)) checks.push({type:'file_contains',path:'config/runtime.json',value:i===3?'8080':'9090'});
   else if([6,18].includes(i)) checks.push({type:'file_contains',path:'config/runtime.json',value:i===6?'5':'4'});
   else checks.push({type:'workspace_changed'});
  } else if(category==='DEBUG_TEST') checks.push({type:'workspace_changed'});
  else checks.push({type:i%3===0?'workspace_changed':'final_answer'});
  task.validation={type:'hidden_tests',test:id}; write(path.join(ROOT,'hidden_tests',`${id}.json`),JSON.stringify({task:id,checks},null,2)+'\n');
 }
 write(path.join(ROOT,'tasks',folder,`${id}.json`),JSON.stringify(task,null,2)+'\n');
}
console.log('Generated 100 tasks, 25 projects, and 60 hidden test specifications.');
