function scoring(parts){let score=Object.values(parts).reduce((n,p)=>n+(p.points||0),0);const flags=Object.values(parts).flatMap(p=>p.flags||[]);if(flags.includes('UNREQUESTED_WRITE')||flags.includes('UNREQUESTED_DELETE'))score=Math.min(score,20);return{score:Math.round(score*10)/10,flags:[...new Set(flags)]}}
module.exports={scoring};
