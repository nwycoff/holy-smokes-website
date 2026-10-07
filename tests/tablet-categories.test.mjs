import test from 'node:test';
import assert from 'node:assert/strict';
import {classify,matchesFacets} from '../assets/tablet/categories.js';
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
test('independent pre-roll filters intersect; unknown names never imply infusion',()=>{
 const p={browse:classify({sourceCategory:'Infused Pre-Roll Multi pk'})};
 assert.equal(matchesFacets(p,new Set(['Type:Regular','Pack:Singles'])),true);
 assert.equal(matchesFacets(p,new Set(['Pack:Multipacks'])),false);
 assert.equal(classify({sourceCategory:'Infused Blunt'}).facets.Pack,'Not specified');
 const c=classify({sourceCategory:'New category',name:'Infused super product',thc:[80,80]});
 assert.deepEqual(c,{section:'New category',facets:{}});
 assert.equal(classify({category:'Legacy group'}).section,'Legacy group');
});
