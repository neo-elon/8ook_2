const fs = require('fs');
const recordMap = JSON.parse(fs.readFileSync('recordMap.json', 'utf8'));

if (recordMap.collection) {
  console.log('\n--- Collections ---');
  for (const [id, col] of Object.entries(recordMap.collection)) {
    const val = col.value?.value || col.value || col;
    const name = val.name?.[0]?.[0] || 'Unnamed';
    console.log(`Collection ID: ${id} -> Name: ${name}`);
  }
}



