// Fictional design data only. Never imported on the live app route.
export const demoMenu = {
  updatedAt: 0, stale: false, pricesIncludeTax: true,
  categories: ['Flower', 'Concentrates', 'Vapes', 'Edibles'],
  products: [
    { id:'demo-1', brand:'Sample Garden', name:'Golden Hour', category:'Flower', limitGroup:'flower', flower:true, type:'hybrid', thc:[24.2,24.2], cbd:null, cbdRich:false,
      terpenes:[1.62,1.62],
      variants:[{size:'3.5 g',priceCents:1500,grams:3.5,pricePerGramCents:429,available:2,limitUse:3.5}], description:'Bright, citrusy and easygoing.' },
    { id:'demo-2', brand:'Sample Garden', name:'Sunday Slowdown', category:'Flower', limitGroup:'flower', flower:true, type:'indica', thc:[26.5,26.5], cbd:null, cbdRich:false,
      terpenes:[1.88,2.05],
      variants:[{size:'3.5 g',priceCents:2000,grams:3.5,pricePerGramCents:571,available:10,limitUse:3.5}] },
    { id:'demo-3', brand:'Example Extracts', name:'Citrus Live Resin', category:'Concentrates', limitGroup:'concentrate', type:'sativa', thc:[72.4,72.4], cbd:null, cbdRich:false,
      variants:[{size:'1 g',priceCents:2000,grams:1,pricePerGramCents:2000,available:10,limitUse:1}] },
    { id:'demo-4', brand:'Prairie Sample Farms', name:'Morning Meadow', category:'Flower', limitGroup:'flower', flower:true, type:'sativa', thc:[22.1,23.3], cbd:null, cbdRich:false,
      variants:[{size:'3.5 g',priceCents:2500,grams:3.5,pricePerGramCents:714,available:10,limitUse:3.5},{size:'7 g',priceCents:4500,grams:7,pricePerGramCents:643,available:10,limitUse:7}] },
    { id:'demo-5', brand:'Example Extracts', name:'Evening Blend Cartridge', category:'Vapes', limitGroup:'concentrate', type:'hybrid', thc:[80.1,80.1], cbd:null, cbdRich:false,
      variants:[{size:'1 g',priceCents:3000,grams:1,pricePerGramCents:3000,available:10,limitUse:1}] },
    { id:'demo-6', brand:'Example Kitchen', name:'Peach Gummies', category:'Edibles', limitGroup:'edible', type:'', thc:null, cbd:null, cbdRich:false,
      variants:[{size:'10 pieces',priceCents:1800,grams:null,pricePerGramCents:null,available:10,limitUse:0.353}] },
    { id:'demo-7', brand:'Prairie Sample Farms', name:'Easy Balance', category:'Flower', limitGroup:'flower', flower:true, type:'hybrid', thc:[6.2,6.2], cbd:[11.8,11.8], cbdRich:true,
      variants:[{size:'3.5 g',priceCents:2200,grams:3.5,pricePerGramCents:629,available:10,limitUse:3.5},{size:'14 g',priceCents:7000,grams:14,pricePerGramCents:500,available:10,limitUse:14}],
      description:'A gentle 1:2 THC to CBD flower.' }
  ]
};
export const demoPurchaseLimits = {
  flower: { label:'flower', unit:'g', measure:'unit', max:84 }, concentrate: { label:'concentrate', unit:'g', measure:'unit', max:28 },
  edible: { label:'edible', unit:'oz', measure:'net', max:72 }, topical: { label:'topical', unit:'oz', measure:'unit', max:72 },
  seed: { label:'seed', unit:'each', measure:'count', max:10 }, clone: { label:'clone', unit:'each', measure:'count', max:6 }
};
export const demoRewards = { updatedAt: 0, tiers: [
  { id:'demo-r1', name:'225 Points - $10 Off', points:225, amountCents:1000, type:'Entire Order by Amount' },
  { id:'demo-r2', name:'500 Points - $25 Off', points:500, amountCents:2500, type:'Entire Order by Amount' },
  { id:'demo-r3', name:'1000 Points - $70 Off', points:1000, amountCents:7000, type:'Entire Order by Amount' },
  { id:'demo-r4', name:'2000 Points - $150 Off', points:2000, amountCents:15000, type:'Entire Order by Amount' }
] };
