import { readFileSync } from "node:fs";
import { describe, it, expect, vi } from "vitest";
import { createWorkspaceRuntime } from "@/core/runtime/runtime";
import { pairKey } from "@/core/runtime/store";
import type { WorkerBroker } from "@/core/runtime/worker-broker";

function deferred() { let resolve!: (v: unknown) => void; const promise = new Promise(r => { resolve = r; }); return {promise,resolve}; }
const result = (offsetY: number) => ({offsetY,status:'matched',confidenceClass:'high',confidence:0.95,bands:{top:0,bottom:0},breakdown:{caps:[]}});
async function workspace() {
  const requests: {op: string; signal?: AbortSignal; task: ReturnType<typeof deferred>}[] = [];
  const broker = {started:new Set(),release:vi.fn(),dispose:vi.fn(),run:vi.fn((_kind:string,op:string,_input:unknown,opts?:{signal?:AbortSignal})=>{
    if(op==='image.preview') return Promise.resolve({bitmap:{width:200,height:300,close:vi.fn()}});
    const task=deferred(); requests.push({op,signal:opts?.signal,task}); return task.promise;
  })} as unknown as WorkerBroker;
  const runtime=createWorkspaceRuntime({broker,caps:{offscreenCanvas:true,compressionStream:true,createImageBitmapResize:true}});
  const files=['a','b'].map(n=>new File([readFileSync(`src/tests/fixtures/stitch/chat-light/${n}.png`)],`${n}.png`,{type:'image/png'}));
  const {added}=await runtime.ingest(files,'picker');
  return {runtime,requests,key:pairKey(added[0],added[1]),added};
}
describe('Stitch request ownership',()=>{
 it('coalesces concurrent analysis calls and publishes one result',async()=>{
  const {runtime,requests,key}=await workspace();try {
    const a=runtime.analyseStitch(),b=runtime.analyseStitch();await vi.waitFor(()=>expect(requests).toHaveLength(1));
    requests[0].task.resolve(result(1200));await Promise.all([a,b]);expect(runtime.store.getState().stitch.pairs[key].offset).toBe(1200);
  }finally{runtime.dispose();}
 });
 it('a cancelled old result cannot replace a forced retry',async()=>{
  const {runtime,requests,key}=await workspace();try {
    const old=runtime.analyseStitch();await vi.waitFor(()=>expect(requests).toHaveLength(1));
    runtime.cancelStitch();const fresh=runtime.analyseStitch({force:true});await vi.waitFor(()=>expect(requests).toHaveLength(2));
    expect(requests[0].signal?.aborted).toBe(true);requests[0].task.resolve(result(300));await old;
    expect(runtime.store.getState().stitch.pairs[key].status).toBe('analysing');requests[1].task.resolve(result(1200));await fresh;
    expect(runtime.store.getState().stitch.pairs[key].offset).toBe(1200);
  }finally{runtime.dispose();}
 });
 it('a normal call after cancellation starts a fresh request rather than coalescing with the aborted run',async()=>{
  const {runtime,requests,key}=await workspace();try{
    const old=runtime.analyseStitch();await vi.waitFor(()=>expect(requests).toHaveLength(1));runtime.cancelStitch();
    const fresh=runtime.analyseStitch();await vi.waitFor(()=>expect(requests).toHaveLength(2));
    requests[0].task.resolve(result(300));requests[1].task.resolve(result(1200));await Promise.all([old,fresh]);
    expect(runtime.store.getState().stitch.pairs[key].offset).toBe(1200);
  }finally{requests.forEach(r=>r.task.resolve(result(1200)));runtime.dispose();}
 });
 it('removal does not resurrect an old pair or leave a running job',async()=>{
  const {runtime,requests,added,key}=await workspace();try {
    const run=runtime.analyseStitch();await vi.waitFor(()=>expect(requests).toHaveLength(1));runtime.removeFile(added[1]);requests[0].task.resolve(result(1200));await run;
    expect(runtime.store.getState().stitch.pairs[key]).toBeUndefined();expect(runtime.store.getState().jobs[`analyse:${key}`].status).toBe('cancelled');
  }finally{runtime.dispose();}
 });
 for(const cancel of [false,true])it(cancel?'cancelled exports cannot publish artifacts':'changing a join during export cannot publish obsolete output',async()=>{
  const {runtime,requests,key}=await workspace();try {
    const analysis=runtime.analyseStitch();await vi.waitFor(()=>expect(requests).toHaveLength(1));requests[0].task.resolve(result(1200));await analysis;
    const output=runtime.exportStitch();void output.catch(()=>{});await vi.waitFor(()=>expect(requests).toHaveLength(2));
    if(cancel)runtime.cancelStitch();else runtime.store.getState().setPairOffset(key,1000);
    requests[1].task.resolve({blob:new Blob(['obsolete']),width:1170,height:3732,ms:1});
    await expect(output).rejects.toMatchObject({code:'CANCELLED'});expect(Object.values(runtime.store.getState().files).filter(f=>f.producedBy==='stitch')).toHaveLength(0);
  }finally{runtime.dispose();}
 });
});
