import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { createWorkspaceRuntime } from "@/core/runtime/runtime";
import type { OcrService, ExtractOptions, ExtractResult } from "@/core/ocr/ocr-service";
import type { WorkerBroker } from "@/core/runtime/worker-broker";

function pending<T>() { let resolve!: (value: T) => void; let reject!: (error: unknown) => void; const promise=new Promise<T>((a,b)=>{resolve=a;reject=b;}); return {promise,resolve,reject}; }
const result=(text:string):ExtractResult=>({rawText:text,editedText:text,language:"eng",blocks:[],image:{width:1170,height:2532},readingOrder:"auto",preprocessing:[],durationMs:1,engine:{name:"test",version:"1"},parts:1,fallbacks:[],timings:{validateMs:0,prepareMs:0,initMs:0,recogniseMs:1,totalMs:1}});
async function workspace(){
  const requests:{options:ExtractOptions;job:ReturnType<typeof pending<ExtractResult>>}[]=[];
  const service={extract:vi.fn((_blob:Blob,options:ExtractOptions)=>{const job=pending<ExtractResult>();requests.push({options,job});return job.promise;}),cancel:vi.fn(async()=>{}),dispose:vi.fn(async()=>{})} as unknown as OcrService;
  const broker={started:new Set(),run:vi.fn(async()=>({bitmap:{width:200,height:300,close:vi.fn()}})),release:vi.fn(),dispose:vi.fn()} as unknown as WorkerBroker;
  const runtime=createWorkspaceRuntime({broker,caps:{offscreenCanvas:true,compressionStream:true,createImageBitmapResize:true},createOcrService:async()=>service});
  const accepted=await runtime.ingest([new File([readFileSync("src/tests/fixtures/stitch/chat-light/a.png")],"input.png",{type:"image/png"})],"picker");
  return {runtime,id:accepted.added[0],requests,service};
}

describe("OCR workspace request ownership",()=>{
  it("a request waiting for retirement cannot replace a newer request",async()=>{
    const {runtime,id,requests,service}=await workspace(); const retiring=pending<void>();
    try {
      const first=runtime.extractText(id);void first.catch(()=>{});await vi.waitFor(()=>expect(requests).toHaveLength(1));
      vi.mocked(service.cancel).mockImplementationOnce(()=>retiring.promise);
      const older=runtime.extractText(id);void older.catch(()=>{});
      const latest=runtime.extractText(id);await vi.waitFor(()=>expect(requests).toHaveLength(2));
      retiring.resolve();await expect(older).rejects.toMatchObject({code:"OCR_CANCELLED"});
      requests[0].job.resolve(result("obsolete"));await first.catch(()=>{});
      requests[1].job.resolve(result("latest"));await latest;
      expect(requests).toHaveLength(2);expect(runtime.ocrResults.forAsset(id)?.rawText).toBe("latest");
    }finally{retiring.resolve();requests.forEach(r=>r.job.resolve(result("cleanup")));runtime.dispose();}
  });
  it("a cancelled result cannot publish over a retry for the same screenshot",async()=>{
    const {runtime,id,requests}=await workspace();
    try{
      const old=runtime.extractText(id);void old.catch(()=>{});await vi.waitFor(()=>expect(requests).toHaveLength(1));await runtime.cancelOcr(id,true);
      const fresh=runtime.extractText(id);await vi.waitFor(()=>expect(requests).toHaveLength(2));requests[0].job.resolve(result("obsolete"));
      await expect(old).rejects.toMatchObject({code:"OCR_CANCELLED"});expect(runtime.store.getState().ocr.byAsset[id].status).toBe("running");expect(runtime.ocrResults.forAsset(id)).toBeUndefined();
      requests[1].job.resolve(result("latest"));await fresh;expect(runtime.ocrResults.forAsset(id)?.rawText).toBe("latest");
    }finally{requests.forEach(r=>r.job.resolve(result("cleanup")));runtime.dispose();}
  });
  it("late failure and progress from an old request leave a newer request running",async()=>{
    const {runtime,id,requests}=await workspace();
    try{
      const old=runtime.extractText(id);void old.catch(()=>{});await vi.waitFor(()=>expect(requests).toHaveLength(1));await runtime.cancelOcr(id,true);
      const fresh=runtime.extractText(id);await vi.waitFor(()=>expect(requests).toHaveLength(2));requests[1].options.onProgress?.(0.2,"current");requests[0].options.onProgress?.(0.95,"stale");
      expect(runtime.store.getState().ocr.byAsset[id].progress).toBe(0.2);requests[0].job.reject(Object.assign(new Error("old model failure"),{code:"OCR_MODEL_LOAD_FAILED"}));await old.catch(()=>{});
      expect(runtime.store.getState().ocr.byAsset[id].status).toBe("running");requests[1].job.resolve(result("latest"));await fresh;
    }finally{requests.forEach(r=>r.job.resolve(result("cleanup")));runtime.dispose();}
  });
  it("removing an input prevents a late OCR result from being retained",async()=>{
    const {runtime,id,requests}=await workspace();
    try{const job=runtime.extractText(id);void job.catch(()=>{});await vi.waitFor(()=>expect(requests).toHaveLength(1));runtime.removeFile(id);requests[0].job.resolve(result("removed"));await expect(job).rejects.toMatchObject({code:"OCR_CANCELLED"});expect(runtime.ocrResults.forAsset(id)).toBeUndefined();}
    finally{runtime.dispose();}
  });
});
