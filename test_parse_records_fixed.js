const fs = require('fs');
const recordMap = JSON.parse(fs.readFileSync('recordMap.json', 'utf8'));

const collectionId = Object.keys(recordMap.collection || {})[0];
const collection = recordMap.collection?.[collectionId]?.value?.value;

console.log('Collection Title:', collection?.name?.[0]?.[0]);
console.log('Schema properties:');
for (const [key, prop] of Object.entries(collection?.schema || {})) {
  console.log(`- ${key}: name="${prop.name}", type="${prop.type}"`);
}

const blocks = Object.values(recordMap.block || {}).map(b => b.value?.value).filter(Boolean);
console.log('Total blocks:', blocks.length);
const pages = blocks.filter(b => b.type === 'page');
console.log('Pages:', pages.length);

pages.forEach((p, idx) => {
  const title = p.properties?.title?.[0]?.[0] || 'Untitled';
  console.log(`\n[${idx + 1}] Title: ${title}`);
  
  // Print properties mapped to schema
  for (const [key, val] of Object.entries(p.properties || {})) {
    if (key === 'title') continue;
    const schemaProp = collection?.schema?.[key];
    const schemaName = schemaProp?.name || key;
    
    // Notion values can be complex arrays. Let's write a small helper to extract clean text.
    let cleanVal = '';
    if (val && Array.isArray(val)) {
      cleanVal = val.map(segment => segment[0]).join('').trim();
    }
    
    console.log(`  - ${schemaName}: ${cleanVal}`);
  }

  // Cover image
  if (p.format?.page_cover) {
    console.log(`  - Cover: ${p.format.page_cover}`);
  }
});
