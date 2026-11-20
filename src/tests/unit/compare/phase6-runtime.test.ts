import {readFileSync} from 'node:fs';
import {afterEach,describe,it,expect,vi} from 'vitest';
import {createWorkspaceRuntime} from '@/core/runtime/runtime';
import {comparePairKey} from '@/core/runtime/compare-analysis-registry';
import {DEFAULT_COMPARE} from '@/core/compare/presets';
import type {WorkerBroker} from '@/core/runtime/worker-broker';
const mocks=vi.hoisted(()=>({draw:vi.fn()}));
vi.mock('@/core/compare/draw',()=>({drawCompare:(...args:unknown[])=>mocks.draw(...args)}));
afterEach(()=>{vi.unstubAllGlobals();mocks.draw.mockReset()});
const analysis=(changedPixels=12)=>({width:100,height:100,analysisScale:1,changedPixels,comparedPixels:10000,totalPixels:10000,ignoredPixels:0,changedPercent:changedPixels/100,unchangedPercent:100-changedPixels/100,metric:'pixel' as const,regions:[],regionsTruncated:false});
async function workspace(){
 const exports:{resolve:(v:unknown)=>void;signal?:AbortSignal}[]=[];
 const broker={started:new Set(),release:vi.fn(),dispose:vi.fn(),run:vi.fn((_kind:string,op:string,_input:unknown,options?:{signal?:AbortSignal})=>op==='compare.export'?new Promise(resolve=>exports.push({resolve,signal:options?.signal})):Promise.resolve({bitmap:{width:200,height:300,close:vi.fn()}}))} as unknown as WorkerBroker;
 const runtime=createWorkspaceRuntime({broker,caps:{offscreenCanvas:true,compressionStream:true,createImageBitmapResize:true}});
 vi.stubGlobal('OffscreenCanvas',class {constructor(public width:number,public height:number){}getContext(){return {clearRect(){},drawImage(){},getImageData(){return {data:new Uint8ClampedArray([0,0,0,255])}}}}});
 const {added}=await runtime.ingest(['a','b'].map(n=>new File([readFileSync(`src/tests/fixtures/stitch/chat-light/${n}.png`)],`${n}.png`,{type:'image/png'})),'picker');
 await vi.waitFor(()=>expect(added.every(id=>!!runtime.registry.preview(id))).toBe(true));
 runtime.store.getState().setCompare({...DEFAULT_COMPARE,a:added[0],b:added[1],mode:'difference'});
 return {runtime,added,exports,pair:comparePairKey(...added as [string,string])};
}
describe('Compare report ownership',()=>{
 it('measures fresh pixels instead of exporting a cached measurement for obsolete settings',async()=>{
  const {runtime,pair}=await workspace();try{
   mocks.draw.mockReturnValue(analysis());expect(await runtime.measureCompare()).toMatchObject({changedPixels:12});mocks.draw.mockClear();runtime.compareAnalyses.setVisual(pair,analysis(0));
   const output=await runtime.exportCompareReport('json',{download:false});
   expect(JSON.parse(await output.blob.text()).totals.changedPixels).toBe(12);expect(mocks.draw).toHaveBeenCalledTimes(1);
  }finally{runtime.dispose()}
 });
 it('settings changed during measurement cannot publish a report or stale visual result',async()=>{
  const {runtime,pair}=await workspace();try{
   mocks.draw.mockImplementation(()=>{runtime.store.getState().setCompare({...runtime.store.getState().compare,threshold:99});return analysis()});
   await expect(runtime.exportCompareReport('json',{download:false})).rejects.toMatchObject({code:'COMPARE_CANCELLED'});
   expect(runtime.compareAnalyses.report(pair)).toBeNull();expect(runtime.compareAnalyses.visual(pair)).toBeNull();
  }finally{runtime.dispose()}
 });
 for(const cancel of [true,false])it(cancel?'cancelled image exports cannot publish or download output':'settings changes prevent an obsolete comparison export being published',async()=>{
  const {runtime,exports}=await workspace();try{
   const output=runtime.exportCompare();void output.catch(()=>{});await vi.waitFor(()=>expect(exports).toHaveLength(1));
   if(cancel)runtime.cancelCompareExport();else runtime.store.getState().setCompare({...runtime.store.getState().compare,threshold:99});
   if(cancel)expect(exports[0].signal?.aborted).toBe(true);
   exports[0].resolve({blob:new Blob(['obsolete']),width:1170,height:2532,ms:1});
   await expect(output).rejects.toMatchObject({code:'COMPARE_CANCELLED'});expect(Object.values(runtime.store.getState().files).some(f=>f.producedBy==='compare')).toBe(false);
  }finally{runtime.dispose()}
 });
});
