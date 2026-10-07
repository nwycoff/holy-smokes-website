import test from 'node:test';
import assert from 'node:assert/strict';
import {inSection,matchesFacets} from '../assets/tablet/categories.js';
import {classifyProduct,packOf,CATEGORIES,HIDDEN,DEPARTMENTS} from '../server/customer-app/taxonomy.mjs';

test('GrowFlow categories land in industry-standard departments; Treehouse stays in Flower too',()=>{
 for (const [category,department,facets,house=false] of [
  ['Tree House Top Shelf Flower','Flower',{Style:'Whole flower',Packaging:'Bulk'},true],
  ['Pre-Pack Tree House Smalls 14g','Flower',{Style:'Smalls',Packaging:'Pre-packed'},true],
  ['Pre-Pack Smalls - 14g','Flower',{Style:'Smalls',Packaging:'Pre-packed'}],
  ['Moonrocks','Flower',{Style:'Infused',Packaging:'Pre-packed'}],
  ['Infused Pre-Roll Multi pk','Pre-Rolls',{Type:'Infused',Format:'Joints',Pack:'Multipacks'}],
  ['Disposable Carts','Vapes',{Style:'Disposables'}],
  ['Cured - 7g','Concentrates',{Style:'Cured resin'}],
  ['Live Diamonds 7g','Concentrates',{Style:'Diamonds'}],
  ['2000mg-5000mg Edibles','Edibles',{Strength:'2,000–5,000mg'}],
  ['Transdermal Patch','Tinctures & Topicals',{Style:'Patches'}],
  ['Delta 8 Products','CBD & Hemp',{Style:'Delta 8'}],
  ['Clone','Seeds & Clones',{Style:'Clones'}],
  ['Puffco','Accessories',{Style:'Dab tools'}]])
  assert.deepEqual(classifyProduct(category,'x'),{department,facets,house},category);
 assert.deepEqual(classifyProduct('Brand new category','x'),{department:'More',facets:{},house:false});
 for (const hidden of ['Waste','Waste - Disposable','waste - pre-roll multi pk','Nicotine Products','Sample- Flower','Pre-Pack Flower Samples'])
  assert.equal(classifyProduct(hidden,'x'),null,hidden);
 for (const {department} of Object.values(CATEGORIES)) assert.ok(DEPARTMENTS.includes(department));
 assert.ok([...HIDDEN].every(name=>!(name in CATEGORIES)));
});
test('blunt pack size comes from the name; other categories keep their own pack; infusion never from names',()=>{
 for (const [name,pack] of [['MoonRock Blunt - 2pk - Guava Gelato - 3g','Multipacks'],['MoonRock | Blunt | 2 pk - True OG - 3g','Multipacks'],
   ['MoonRock - Infused Blunt (2 Pack) - Grapeness - 3g','Multipacks'],['Infused Blunt 1.5g (2 Pack) - Alaskan Thunder - 3g','Multipacks'],
   ['Blunt Power Plant | 2.5g','Singles'],['Blunt 1pk - Solo','Singles'],['Blunt - 3.5g','Singles']])
  assert.equal(classifyProduct('Infused Blunt',name).facets.Pack,pack,name);
 assert.equal(packOf('Pre-roll 0.5g 7pk'),'Multipacks');assert.equal(packOf('Pre-roll 1g'),null);
 assert.equal(classifyProduct('Infused Pre-Roll','Infused Pre-Roll 5pk').facets.Pack,'Singles');
 assert.equal(classifyProduct('Pre-Roll','Infused super pre-roll').facets.Type,'Regular');
});
test('checked filters narrow: any value within a group, every group across; Treehouse tab uses the house flag',()=>{
 const p={category:'Pre-Rolls',facets:{Type:'Infused',Format:'Joints',Pack:'Multipacks'}};
 assert.equal(matchesFacets(p,new Set()),true);
 assert.equal(matchesFacets(p,new Set(['Pack:Multipacks'])),true);
 assert.equal(matchesFacets(p,new Set(['Format:Joints','Format:Blunts','Pack:Multipacks'])),true);
 assert.equal(matchesFacets(p,new Set(['Type:Regular','Pack:Multipacks'])),false);
 assert.equal(matchesFacets(p,new Set(['Type:Regular','Pack:Multipacks']),'Type'),true);
 assert.equal(matchesFacets(p,new Set(['Format:Blunts'])),false);
 const house={category:'Flower',house:true};
 assert.equal(inSection(house,'Treehouse'),true);assert.equal(inSection(house,'Flower'),true);assert.equal(inSection(p,'Treehouse'),false);
 assert.equal(inSection(p,'All'),true);
});
