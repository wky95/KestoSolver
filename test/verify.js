// Replays a move string through the Play-mode rule (the one proven to match solver.js).
const fs=require('fs');
const P=JSON.parse(fs.readFileSync(process.argv[2],'utf8'));
const moves=process.argv[3].split('');
function applyMove(blocks,dir,bg){
  const isRow=dir==='L'||dir==='R', step=(dir==='U'||dir==='L')?-1:+1;
  const occ=new Set(blocks.map(b=>b.r*8+b.c)), sh=new Map();
  for(let line=0;line<8;line++){
    const at=i=>isRow?{r:line,c:i}:{r:i,c:line};
    const has=i=>{const p=at(i);return occ.has(p.r*8+p.c);};
    const wall=i=>{const p=at(i);return bg[p.r][p.c]==='#';};
    let i=0;
    while(i<8){ if(!has(i)){i++;continue;}
      let j=i; while(j+1<8&&has(j+1))j++;
      const lead=step>0?j:i, ahead=lead+step;
      if(ahead>=0&&ahead<=7&&!wall(ahead)) for(let k=i;k<=j;k++){const f=at(k),t=at(k+step);sh.set(f.r*8+f.c,t.r*8+t.c);}
      i=j+1; } }
  if(!sh.size)return null;
  return blocks.map(b=>{const m=sh.get(b.r*8+b.c);return m===undefined?b:{r:m>>3,c:m&7};});
}
let blocks=[];
for(let r=0;r<8;r++)for(let c=0;c<8;c++)if(P.fg[r][c]==='Y')blocks.push({r,c});
const n0=blocks.length;
for(let i=0;i<moves.length;i++){
  const nx=applyMove(blocks,moves[i],P.bg);
  if(!nx){console.log(`move ${i+1} (${moves[i]}) is a no-op`);process.exit(1);}
  blocks=nx;
}
const targets=[]; for(let r=0;r<8;r++)for(let c=0;c<8;c++)if(P.bg[r][c]==='T')targets.push(r*8+c);
const occ=new Set(blocks.map(b=>b.r*8+b.c));
console.log(`blocks ${n0} -> ${blocks.length}, targets ${targets.length}`);
console.log(targets.length===blocks.length&&targets.every(t=>occ.has(t))
  ? `VALID: ${moves.length} moves, every block on a target`
  : 'INVALID: final position is not the goal');
