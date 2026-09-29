function grounding(task,run){const flags=[];if(run.flags?.includes('HALLUCINATED_WORKSPACE'))flags.push('HALLUCINATED_WORKSPACE');return{points:flags.length?0:10,flags}}
module.exports={grounding};
