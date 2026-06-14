const fs = require('fs');
const html = fs.readFileSync('index.html', 'utf8');
console.log('notion-modal count:', (html.match(/id="notion-modal"/g) || []).length);
console.log('notion-url count:', (html.match(/id="notion-url"/g) || []).length);

