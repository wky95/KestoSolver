const ROOT = path.join(__dirname, '..');
const FIXTURES = path.join(__dirname, 'fixtures');
const fs=require('fs'),vm=require('vm'),path=require('path');
const sb={console,atob,Uint8Array,BigInt,Error,Array,fetch,JSON,Math,Number,String,RegExp,Promise};
sb.globalThis=sb;vm.createContext(sb);
vm.runInContext(fs.readFileSync(path.join(ROOT,'kesto-api.js'),'utf8')+'\nglobalThis.__f=fetchKestoPuzzle;',sb);
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
(async()=>{
  const ids=[];
  const start=new Date(Date.UTC(2026,4,23)), end=new Date(Date.UTC(2026,7,15));
  for(let d=new Date(start); d<=end; d.setUTCDate(d.getUTCDate()+3)){
    ids.push(`${d.getUTCFullYear()}${String(d.getUTCMonth()+1).padStart(2,'0')}${String(d.getUTCDate()).padStart(2,'0')}`);
  }
  let ok=0,failed=0;
  for(const id of ids){
    if(fs.existsSync(path.join(FIXTURES, `puzzle-${id}.json`))){ok++;continue;}
    try{
      const p=await sb.__f(id);
      fs.writeFileSync(path.join(FIXTURES, `puzzle-${p.id}.json`),JSON.stringify({bg:p.bgGrid,fg:p.fgGrid,stars:p.stars,boxCount:p.boxCount}));
      ok++;
    }catch(e){failed++; console.log(`${id}: ${e.message}`);}
    await sleep(250);
  }
  console.log(`fetched ${ok}, failed ${failed}`);
})();
