// Fictional design data only. Never imported on the live app route.
export const demoMenu = {
  updatedAt: 0, stale: false, pricesIncludeTax: true,
  categories: ['Flower', 'Concentrates', 'Vapes', 'Edibles'],
  products: [
    { id:'demo-1', brand:'Sample Garden', name:'Golden Hour', category:'Flower', flower:true, type:'hybrid', thc:[24.2,24.2], cbd:null, cbdRich:false,
      variants:[{size:'3.5 g',priceCents:1500,grams:3.5,pricePerGramCents:429}], description:'Bright, citrusy and easygoing.' },
    { id:'demo-2', brand:'Sample Garden', name:'Sunday Slowdown', category:'Flower', flower:true, type:'indica', thc:[26.5,26.5], cbd:null, cbdRich:false,
      variants:[{size:'3.5 g',priceCents:2000,grams:3.5,pricePerGramCents:571}] },
    { id:'demo-3', brand:'Example Extracts', name:'Citrus Live Resin', category:'Concentrates', type:'sativa', thc:[72.4,72.4], cbd:null, cbdRich:false,
      variants:[{size:'1 g',priceCents:2000,grams:1,pricePerGramCents:2000}] },
    { id:'demo-4', brand:'Prairie Sample Farms', name:'Morning Meadow', category:'Flower', flower:true, type:'sativa', thc:[22.1,23.3], cbd:null, cbdRich:false,
      variants:[{size:'3.5 g',priceCents:2500,grams:3.5,pricePerGramCents:714},{size:'7 g',priceCents:4500,grams:7,pricePerGramCents:643}] },
    { id:'demo-5', brand:'Example Extracts', name:'Evening Blend Cartridge', category:'Vapes', type:'hybrid', thc:[80.1,80.1], cbd:null, cbdRich:false,
      variants:[{size:'1 g',priceCents:3000,grams:1,pricePerGramCents:3000}] },
    { id:'demo-6', brand:'Example Kitchen', name:'Peach Gummies', category:'Edibles', type:'', thc:null, cbd:null, cbdRich:false,
      variants:[{size:'10 pieces',priceCents:1800,grams:null,pricePerGramCents:null}] },
    { id:'demo-7', brand:'Prairie Sample Farms', name:'Easy Balance', category:'Flower', flower:true, type:'hybrid', thc:[6.2,6.2], cbd:[11.8,11.8], cbdRich:true,
      variants:[{size:'3.5 g',priceCents:2200,grams:3.5,pricePerGramCents:629},{size:'14 g',priceCents:7000,grams:14,pricePerGramCents:500}],
      description:'A gentle 1:2 THC to CBD flower.' }
  ]
};
export const demoRewards = { updatedAt: 0, tiers: [
  { id:'demo-r1', name:'225 Points - $10 Off', points:225, amountCents:1000, type:'Entire Order by Amount' },
  { id:'demo-r2', name:'500 Points - $25 Off', points:500, amountCents:2500, type:'Entire Order by Amount' },
  { id:'demo-r3', name:'1000 Points - $70 Off', points:1000, amountCents:7000, type:'Entire Order by Amount' },
  { id:'demo-r4', name:'2000 Points - $150 Off', points:2000, amountCents:15000, type:'Entire Order by Amount' }
] };
