import {describe,it,expect} from "vitest";
import {planStitch} from "@/core/stitch/plan";
import {planStitchChain} from "@/core/stitch/chain";

describe("short and unequal-height stitch composition",()=>{
 it("preserves the earlier screenshot's tail when a shorter screenshot is contained",()=>{
  const a={width:100,height:1000},b={width:100,height:100},bands={top:0,bottom:0};
  const pair=planStitch(a,b,800,bands);
  expect(pair.height).toBe(1000);
  expect(pair.segments.every(s=>s.height>0&&s.sy>=0&&s.sy+s.height<=(s.source==='a'?a.height:b.height))).toBe(true);
  const chain=planStitchChain([a,b],[{offsetY:800,bands}]);
  expect(chain.height).toBe(1000);
  expect(chain.segments.map(s=>({...s,source:s.source===0?'a':'b'}))).toEqual(pair.segments);
 });
 it("covers every row exactly once and never reads beyond any source in mixed-height chains",()=>{
  const dims=[{width:100,height:1000},{width:101,height:100},{width:100,height:800},{width:100,height:90}];
  const p=planStitchChain(dims,[800,1,500].map(offsetY=>({offsetY,bands:{top:0,bottom:0}})));
  expect(p.height).toBe(Math.max(...dims.map((d,i)=>p.tops[i]+d.height)));
  const coverage=new Uint8Array(p.height);
  for(const s of p.segments){expect(s.sy).toBeGreaterThanOrEqual(0);expect(s.sy+s.height).toBeLessThanOrEqual(dims[s.source].height);for(let y=s.dy;y<s.dy+s.height;y++)coverage[y]++;}
  expect([...coverage].every(n=>n===1)).toBe(true);
 });
});
