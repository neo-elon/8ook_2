const fs = require('fs');
const recordMap = JSON.parse(fs.readFileSync('recordMap.json', 'utf8'));

const blockKeys = Object.keys(recordMap.block);
console.log('First block ID:', blockKeys[0]);
console.log('First block raw:', JSON.stringify(recordMap.block[blockKeys[0]], null, 2));
