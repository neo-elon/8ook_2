const fs = require('fs');
const code = fs.readFileSync('app.js', 'utf8');
const lines = code.split('\n');
lines.forEach((line, idx) => {
  if (line.includes('openModal')) {
    console.log(`${idx+1}: ${line.trim()}`);
  }
});
