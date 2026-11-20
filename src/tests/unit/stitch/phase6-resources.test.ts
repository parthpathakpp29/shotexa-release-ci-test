import {afterEach,describe,expect,it,vi} from "vitest";
import {composeChain} from "@/core/stitch/compose-chain";
import {stitchAnalysisIssue} from "@/core/stitch/limits";
vi.mock("@/core/image/image-size",()=>({readImageSize:async()=>({width:100,height:300})}));
afterEach(()=>vi.unstubAllGlobals());
describe('Stitch resource lifetime',()=>{
 const plan={width:100,height:300,segments:[0,1,2].map(source=>({source,sy:0,height:100,dy:source*100}))};
 it('keeps only the source still needed and closes all sources',async()=>{
  let live=0,peak=0,closed=0;
  vi.stubGlobal('createImageBitmap',async()=>{live++;peak=Math.max(peak,live);return {width:100,height:100,close(){live--;closed++;}}});
  const make=(width:number,height:number)=>({width,height,getContext:()=>({drawImage(){},fillRect(){}}),convertToBlob:async()=>new Blob(['png'])}) as unknown as OffscreenCanvas;
  await composeChain([new Blob(),new Blob(),new Blob()],plan,{format:'png',sources:[1,2,3].map(()=>({width:100,height:100})),createCanvas:make});
  expect(peak).toBe(1);expect(live).toBe(0);expect(closed).toBe(3);
 });
 it('rejects cancellation during encoding and still releases the canvas and bitmap',async()=>{
  const abort=new AbortController(),closed=vi.fn();let canvas!:OffscreenCanvas;
  vi.stubGlobal('createImageBitmap',async()=>({width:100,height:100,close:closed}));
  const make=(width:number,height:number)=>canvas={width,height,getContext:()=>({drawImage(){}}),convertToBlob:async()=>{abort.abort();return new Blob(['png']);}} as unknown as OffscreenCanvas;
  await expect(composeChain([new Blob(),new Blob(),new Blob()],plan,{format:'png',signal:abort.signal,sources:[{width:100,height:100}],createCanvas:make})).rejects.toMatchObject({code:'CANCELLED'});
  expect(canvas.width).toBe(0);expect(closed).toHaveBeenCalledTimes(3);
 });
 it('refuses memory/canvas-unsafe analysis without resizing the inputs',()=>{
  expect(stitchAnalysisIssue({width:10000,height:10000},{width:10000,height:10000},true)).toBe('source-memory');
  expect(stitchAnalysisIssue({width:100,height:70000},{width:100,height:100},false)).toBe('fallback-canvas');
  expect(stitchAnalysisIssue({width:1170,height:2532},{width:1170,height:2532},false)).toBeNull();
 });
});
