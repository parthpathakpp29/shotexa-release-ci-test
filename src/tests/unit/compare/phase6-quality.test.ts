import {describe,it,expect} from "vitest";
import {compareBuffers,compareStats} from "@/core/compare/difference";
import {DEFAULT_COMPARE} from "@/core/compare/presets";
import {buildCompareSummary,summaryRows} from "@/core/compare/summary";
import type {CompareDiffSettings} from "@/core/compare/types";
const image=(f:(x:number)=>number[])=>{const a=new Uint8ClampedArray(12*6*4);for(let p=0;p<72;p++)a.set(f(p%12),p*4);return a};
const run=(a:Uint8ClampedArray,b:Uint8ClampedArray,diff:Partial<CompareDiffSettings>={})=>compareBuffers(a,b,new Uint8ClampedArray(a.length),{width:12,height:6,threshold:0,diff:{...DEFAULT_COMPARE.diff,luminanceTolerance:0,...diff},background:[100,100,100]});
describe("conservative optional noise filtering",()=>{
 it("retains a genuine one-pixel binary edge shift with antialiasing filtering enabled",()=>{
  const edge=(n:number)=>image(x=>x<n?[0,0,0,255]:[255,255,255,255]);
  expect(run(edge(5),edge(6),{ignoreAntialiasing:true}).changed).toBe(6);
 });
 for(const filter of ['ignoreNearIdenticalColour','ignoreAntialiasing'] as const)it(`preserves explicitly requested alpha changes with ${filter}`,()=>{
  expect(run(image(()=>[100,100,100,255]),image(()=>[100,100,100,40]),{compareAlpha:true,[filter]:true}).changed).toBe(72);
 });
 it("does not report wholly excluded pixels as unchanged",()=>{
  expect(compareStats(0,0,72,72).unchangedPercent).toBe(0);
 });
 it("filters small edge-shade noise but preserves the same change in a flat area",()=>{
  const edge=(shade:number)=>image(x=>x<5?[0,0,0,255]:x===5?[shade,shade,shade,255]:[255,255,255,255]);
  expect(run(edge(80),edge(86)).changed).toBe(6);
  expect(run(edge(80),edge(86),{ignoreAntialiasing:true}).changed).toBe(0);
  expect(run(image(()=>[80,80,80,255]),image(()=>[86,86,86,255]),{ignoreAntialiasing:true}).changed).toBe(72);
 });
 it("labels a missing measurement instead of reporting zero changes",()=>{
  const file={name:'a.png',width:12,height:6,bytes:100,type:'image/png',transparent:false};
  const s=buildCompareSummary({a:file,b:file,settings:DEFAULT_COMPARE,alignment:null,analysis:null,textDiff:null,generatedAt:0});
  expect(summaryRows(s).find(r=>r.label==='Changed pixels')?.value).toBe('Not measured');
 });
 it("reports the same combined manual and measured transform that is rendered",()=>{
  const file={name:'a.png',width:100,height:100,bytes:100,type:'image/png',transparent:false};
  const s=buildCompareSummary({a:file,b:file,settings:{...DEFAULT_COMPARE,alignment:{mode:'translate-scale',dx:3,dy:-4,scale:1.1}},alignment:{status:'aligned',dx:5,dy:2,scale:0.9,score:0.98,confidence:'high',method:'translate-scale',analysisScale:1},analysis:null,textDiff:null});
  expect(s.alignment).toMatchObject({x:8,y:-2,scalePercent:99});
 });
 it("warns about reduced source previews even when the analysis canvas is full size",()=>{
  const file={name:'a.png',width:100,height:100,bytes:100,type:'image/png',transparent:false};
  const analysis={width:100,height:100,analysisScale:1,sourceScale:0.5,changedPixels:0,comparedPixels:10000,totalPixels:10000,ignoredPixels:0,changedPercent:0,unchangedPercent:100,metric:'pixel' as const,regions:[],regionsTruncated:false};
  const s=buildCompareSummary({a:file,b:file,settings:DEFAULT_COMPARE,alignment:null,analysis,textDiff:null});
  expect(s.analysis?.sourceScale).toBe(0.5);expect(s.warnings.some(w=>w.includes('reduced previews'))).toBe(true);
 });
});
