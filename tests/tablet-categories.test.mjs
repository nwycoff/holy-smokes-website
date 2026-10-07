import test from 'node:test';
import assert from 'node:assert/strict';
import {classify,matchesFacets,packOf} from '../assets/tablet/categories.js';
test('exact categories distinguish Treehouse, smalls, shake and infusion',()=>{
 for(const [sourceCategory,section,type] of [
 ['Pre-Pack Tree House Smalls 14g','Treehouse','Smalls'],
 ['Tree House Top Shelf Flower','Treehouse','Whole Flower'],
 ['Pre-Pack Smalls - 14g','Smalls','Prepacked'],
 ['Infused Shake','Shake','Infused'],
 ['Pre-Pack Shake','Shake','Regular'],
 ['Infused Flower','Infused Flower','Infused Flower']]) {
  const c=classify({sourceCategory});assert.equal(c.section,section);assert.ok(Object.values(c.facets).includes(type));
 }
});
test('checked filters narrow: any value within a group, every group across; unknown names never imply infusion',()=>{
 const p={browse:classify({sourceCategory:'Infused Pre-Roll Multi pk'})};
 assert.equal(matchesFacets(p,new Set()),true); // nothing checked: everything shows
 assert.equal(matchesFacets(p,new Set(['Pack:Multipacks'])),true);
 assert.equal(matchesFacets(p,new Set(['Format:Pre-rolls','Format:Blunts','Pack:Multipacks'])),true);
 assert.equal(matchesFacets(p,new Set(['Type:Regular','Pack:Multipacks'])),false);
 assert.equal(matchesFacets(p,new Set(['Type:Regular','Pack:Multipacks']),'Type'),true); // counts for the Type group
 assert.equal(matchesFacets(p,new Set(['Format:Blunts'])),false);
 const c=classify({sourceCategory:'New category',name:'Infused super product',thc:[80,80]});
 assert.deepEqual(c,{section:'New category',facets:{}});
 assert.equal(classify({category:'Legacy group'}).section,'Legacy group');
});
test('blunt pack size comes from the name; other categories keep their own pack',()=>{
 for (const [name,pack] of [['MoonRock Blunt - 2pk - Guava Gelato - 3g','Multipacks'],['MoonRock | Blunt | 2 pk - True OG - 3g','Multipacks'],
   ['MoonRock - Infused Blunt (2 Pack) - Grapeness - 3g','Multipacks'],['Infused Blunt 1.5g (2 Pack) - Alaskan Thunder - 3g','Multipacks'],
   ['Blunt Power Plant | 2.5g','Singles'],['Blunt 1pk - Solo','Singles'],['Blunt - 3.5g','Singles']])
  assert.equal(classify({sourceCategory:'Infused Blunt',name}).facets.Pack,pack,name);
 assert.equal(packOf('Pre-roll 0.5g 7pk'),'Multipacks');assert.equal(packOf('Pre-roll 1g'),null);
 assert.equal(classify({sourceCategory:'Infused Pre-Roll',name:'Infused Pre-Roll 5pk'}).facets.Pack,'Singles'); // category decides
 assert.ok(!('packFromName' in classify({sourceCategory:'Infused Blunt',name:'x'})));
});
