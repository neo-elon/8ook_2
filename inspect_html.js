const fs = require('fs');
const html = fs.readFileSync('notion_page.html', 'utf8');

console.log('Script tags count:', (html.match(/<script/g) || []).length);

// Print all text inside script tags that might contain JSON or boot data
const scriptRegex = /<script\b[^>]*>([\s\S]*?)<\/script>/g;
let match;
let count = 0;
while ((match = scriptRegex.exec(html)) !== null) {
  count++;
  const content = match[1].trim();
  console.log(`\n--- Script ${count} (length: ${content.length}) ---`);
  if (content.length > 200) {
    console.log(content.slice(0, 200) + '...');
  } else {
    console.log(content);
  }
}
