import type { GrayImage } from "@/core/stitch/types";

/** Deterministic scrolling content, with exact row coordinates as ground truth. */
export function scrollingFixture(options: {width?:number; height?:number; offset?:number; header?:number; footer?:number; noise?:number; period?:number; seed?:number} = {}) {
  const {width=192,height=384,offset=248,header=0,footer=0,noise=0,period=0,seed=13}=options;
  const image=(scroll:number):GrayImage=>{
    const data=new Uint8Array(width*height);
    for(let y=0;y<height;y++)for(let x=0;x<width;x++){
      const fixed=y<header||y>=height-footer;
      let row=fixed?y:y-header+scroll;
      if(period&&!fixed)row%=period;
      let v=Math.imul(Math.floor(x/3)+seed,73856093)^Math.imul(Math.floor(row/3),19349663);
      v=Math.imul(v^(v>>>13),1274126177);
      const base=fixed?40+((x+y)%100):((v^(v>>>16))>>>0)%210+20;
      data[y*width+x]=Math.max(0,Math.min(255,base+(scroll?((x+y)%3-1)*noise:0)));
    }
    return {width,height,data};
  };
  return {a:image(0),b:image(offset),expectedOffset:offset};
}

export const stitchQualityCases = () => [
  {id:"clear",...scrollingFixture()},
  {id:"small-overlap",...scrollingFixture({offset:352})},
  {id:"tiny-overlap",...scrollingFixture({offset:380})},
  {id:"sticky-header-footer",...scrollingFixture({offset:248,header:24,footer:18})},
  {id:"minor-visual-noise",...scrollingFixture({noise:2})},
  {id:"long-conversation",...scrollingFixture({height:2400,offset:1800,header:24,footer:18})},
  {id:"periodic-ambiguous",...scrollingFixture({period:48,offset:240})},
  {id:"no-overlap",...scrollingFixture({offset:900}),expectedOffset:null},
];
