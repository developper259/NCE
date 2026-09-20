function efficiency(task,run){const calls=run.tool_calls||[],seen=new Map();let duplicates=0;for(const c of calls){const k=c.tool+JSON.stringify(c.arguments||{});seen.set(k,(seen.get(k)||0)+1);if(seen.get(k)>1)duplicates++}const excess=Math.max(0,calls.length-(task.limits.max_tool_calls/2));return{points:Math.max(0,5-duplicates-excess*.25),duplicates}}
module.exports={efficiency};
