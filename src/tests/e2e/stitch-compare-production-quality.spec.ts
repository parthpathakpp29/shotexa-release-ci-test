import {expect,test,type Page} from '@playwright/test';
import {PNG} from 'pngjs';
import {readFileSync} from 'node:fs';
import {scrollingFixture} from '../helpers/stitch-quality-fixtures';
import type {GrayImage} from '@/core/stitch/types';

function png(name:string,image:GrayImage){const p=new PNG({width:image.width,height:image.height});for(let i=0;i<image.data.length;i++)p.data.set([image.data[i],image.data[i],image.data[i],255],i*4);return {name,mimeType:'image/png',buffer:PNG.sync.write(p)}}
const exportControl=(page:Page)=>(page.viewportSize()?.width??1440)<768?page.getByRole('button',{name:'Export',exact:true}):page.getByTestId('export');
async function readyStitch(page:Page,images:ReturnType<typeof png>[]){
 await page.goto('/stitch-screenshots');await page.getByTestId('file-input').setInputFiles(images);
 await expect(exportControl(page)).toBeVisible();await expect(exportControl(page)).toBeEnabled({timeout:120000});
}
async function exportPng(page:Page){const [d]=await Promise.all([page.waitForEvent('download'),exportControl(page).click()]);expect(d.suggestedFilename()).toMatch(/\.png$/);return PNG.sync.read(readFileSync((await d.path())!))}
test.describe.configure({timeout:180000});
test.use({viewport:{width:1440,height:960}});

test('Stitch preserves exact original pixels across sticky chrome and the join',async({page})=>{
 const f=scrollingFixture({header:24,footer:18});await readyStitch(page,[png('a.png',f.a),png('b.png',f.b)]);
 await expect(page.getByTestId('stitch-match-evidence')).toContainText('heuristic');
 const output=await exportPng(page);expect([output.width,output.height]).toEqual([192,632]);
 let differentChannels=0;
 for(let y=0;y<output.height;y++)for(let x=0;x<output.width;x++){
  const gray=y<366?f.a.data[y*192+x]:f.b.data[(y-248)*192+x];
  for(let c=0;c<4;c++)if(output.data[(y*192+x)*4+c] !== (c===3?255:gray))differentChannels++;
 }
 expect(differentChannels).toBe(0);
});
test('Stitch manual correction preserves the tail of a contained short screenshot',async({page})=>{
 const f=scrollingFixture({width:96,height:1000,offset:800});const short={...f.b,height:100,data:f.b.data.slice(0,96*100)};
 await readyStitch(page,[png('long.png',f.a),png('short.png',short)]);
 await page.getByRole('button',{name:'Adjust manually',exact:true}).click();
 await page.getByLabel('Exact position').fill('800');await page.getByLabel('Exact position').press('Tab');
 const output=await exportPng(page);expect([output.width,output.height]).toEqual([96,1000]);
 expect(output.data.equals(PNG.sync.read(png('expected.png',f.a).buffer).data)).toBe(true);
});
test('Stitch no-overlap fallback keeps both screenshots end to end',async({page})=>{
 const f=scrollingFixture({offset:900});await readyStitch(page,[png('a.png',f.a),png('b.png',f.b)]);
 await expect(page.getByTestId('stitch-confidence')).toContainText('No overlap found');
 const output=await exportPng(page);expect([output.width,output.height]).toEqual([192,768]);
 expect(output.data.equals(Buffer.concat([PNG.sync.read(png('a.png',f.a).buffer).data,PNG.sync.read(png('b.png',f.b).buffer).data]))).toBe(true);
});
test('390px Stitch keeps native unequal widths, transparent padding and a usable export control',async({page})=>{
 await page.setViewportSize({width:390,height:844});
 const a=scrollingFixture().a,b=scrollingFixture({width:194}).b;
 await readyStitch(page,[png('narrow.png',a),png('wide.png',b)]);
 await expect(page.getByText(/Widths differ\. Originals stay left-aligned/)).toBeVisible();
 await expect.poll(()=>page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth+1)).toBe(true);
 const box=await exportControl(page).boundingBox();expect(box?.height).toBeGreaterThanOrEqual(44);
 const output=await exportPng(page);expect([output.width,output.height]).toEqual([194,632]);
 expect(output.data[193*4+3]).toBe(0);expect(output.data[(194*632-1)*4+3]).toBe(255);
});
test('Stitch cancels pending local vision loading and retries explicitly',async({page})=>{
 let release!:()=>void;const gate=new Promise<void>(r=>release=r);let requested=false;
 await page.route('**/vendor/opencv/**',async route=>{requested=true;await gate;await route.continue().catch(()=>{});});
 try{
  const f=scrollingFixture();await page.goto('/stitch-screenshots');await page.getByTestId('file-input').setInputFiles([png('a.png',f.a),png('b.png',f.b)]);
  await expect.poll(()=>requested).toBe(true);await page.getByRole('button',{name:'Cancel alignment',exact:true}).click();
  await expect(page.getByTestId('stitch-confidence')).toContainText('Alignment cancelled');
  release();await page.unrouteAll({behavior:'wait'});await page.getByRole('button',{name:'Try alignment again',exact:true}).click();
  await expect(page.getByTestId('export')).toBeEnabled({timeout:120000});
  expect((await exportPng(page)).height).toBe(632);
 }finally{release();await page.unrouteAll({behavior:'ignoreErrors'});}
});
test('Compare retains a whole-pixel shift with optional antialiasing filtering',async({page})=>{
 const edge=(at:number):GrayImage=>({width:120,height:60,data:Uint8Array.from({length:7200},(_,i)=>i%120<at?0:255)});
 await page.goto('/compare-screenshots');await page.getByTestId('file-input').setInputFiles([png('before.png',edge(50)),png('after.png',edge(51))]);
 await expect(page.getByTestId('compare-stage')).toBeVisible();
 await page.getByRole('radiogroup',{name:'Comparison mode'}).getByRole('radio',{name:'Difference',exact:true}).click();
 const labels=page.getByRole('switch',{name:'Before / after labels'});if(await labels.getAttribute('aria-checked')==='true')await labels.click();
 await page.getByRole('button',{name:'Noise and colour',exact:true}).click();
 const noiseFilter=page.getByRole('switch',{name:'Ignore anti-aliasing',exact:true});
 await noiseFilter.click();await expect(noiseFilter).toHaveAttribute('aria-checked','true');
 const output=await exportPng(page);expect([output.width,output.height]).toEqual([120,60]);
 let highlighted=0;for(let i=0;i<output.data.length;i+=4)if(output.data[i]>output.data[i+2]+40&&output.data[i]>90)highlighted++;
 expect(highlighted).toBe(60);
 const [download]=await Promise.all([page.waitForEvent('download'),page.getByTestId('compare-report-json').click()]);
 const summary=JSON.parse(readFileSync((await download.path())!,'utf8'));expect(summary.totals.changedPixels).toBe(60);expect(summary.measurement).toBe('measured');
});
