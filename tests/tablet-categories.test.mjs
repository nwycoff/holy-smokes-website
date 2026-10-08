import test from 'node:test';
import assert from 'node:assert/strict';
import {inSection,matchesFacets,potencyLine} from '../assets/tablet/categories.js';
import {classifyProduct,packOf,CATEGORIES,HIDDEN,DEPARTMENTS} from '../server/customer-app/taxonomy.mjs';

test('GrowFlow categories land in medical-shopper headings; flower splits by grade',()=>{
 for (const [category,department,facets,house=false] of [
  ['Tree House Top Shelf Flower','Flower',{Style:'Whole flower',Packaging:'Bulk'},true],
  ['Pre-Pack Tree House Smalls 14g','Smalls',{Style:'Smalls',Packaging:'Pre-packed'},true],
  ['Pre-Pack Smalls - 14g','Smalls',{Style:'Smalls',Packaging:'Pre-packed'}],
  ['Shake','Shake',{Style:'Shake',Packaging:'Bulk'}],
  ['Infused Shake','Shake',{Style:'Infused shake',Packaging:'Pre-packed'}],
  ['Moonrocks','Flower',{Style:'Infused flower',Packaging:'Pre-packed'}],
  ['Tincture','Tinctures & Capsules',{Style:'Tinctures'}],
  ['Infused Pre-Roll Multi pk','Pre-Rolls',{Type:'Infused',Format:'Joints',Pack:'Multipacks'}],
  ['Disposable Carts','Vapes',{Style:'Disposables'}],
  ['Cured - 7g','Concentrates',{Style:'Cured resin'}],
  ['Live Diamonds 7g','Concentrates',{Style:'Diamonds'}],
  ['2000mg-5000mg Edibles','Edibles',{'Per package':'2,000–5,000mg'}],
  ['Transdermal Patch','Topicals & Patches',{Style:'Patches'}],
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
test('checked filters narrow: any value within a group, every group across; extra tabs list products too',()=>{
 const p={category:'Pre-Rolls',facets:{Type:'Infused',Format:'Joints',Pack:'Multipacks'}};
 assert.equal(matchesFacets(p,new Set()),true);
 assert.equal(matchesFacets(p,new Set(['Pack:Multipacks'])),true);
 assert.equal(matchesFacets(p,new Set(['Format:Joints','Format:Blunts','Pack:Multipacks'])),true);
 assert.equal(matchesFacets(p,new Set(['Type:Regular','Pack:Multipacks'])),false);
 assert.equal(matchesFacets(p,new Set(['Type:Regular','Pack:Multipacks']),'Type'),true);
 assert.equal(matchesFacets(p,new Set(['Format:Blunts'])),false);
 const house={category:'Smalls',house:true,also:['Treehouse']};
 assert.equal(inSection(house,'Treehouse'),true);assert.equal(inSection(house,'Smalls'),true);assert.equal(inSection(house,'Flower'),false);assert.equal(inSection(p,'Treehouse'),false);
 assert.equal(inSection(p,'All'),true);
});

test('edible cards show the mg per package, never percent-by-weight potency', () => {
  const edible = { category: 'Edibles', thc: [1.04, 1.04], cbd: [1.2, 1.2], terpenes: [0.1, 0.1], variants: [{ size: '100 mg' }] };
  assert.equal(potencyLine(edible, 'Ask us'), '100 mg per package');
  assert.equal(potencyLine({ ...edible, variants: [{ size: '100 g' }] }, 'Ask us'), 'Ask us for the mg per package');
  assert.equal(potencyLine({ category: 'Flower', thc: [21.3, 24], variants: [{ size: '3.5 g' }] }, 'Ask us'), 'Total THC 21.3–24.0%');
});
