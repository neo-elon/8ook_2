async function test() {
  const url = 'https://ykoops.notion.site/1938775ca0cb80b2920fd92bba68c539';
  try {
    const res = await fetch(url);
    const html = await res.text();
    console.log('HTML Length:', html.length);
    
    // Look for script tags or JSON data
    // Usually Notion embeds the block data in a script tag containing "__INITIAL_STATE__" or "preloadData"
    const matches = html.match(/__INITIAL_STATE__\s*=\s*({.+?});/);
    if (matches) {
      console.log('Found __INITIAL_STATE__!');
      const state = JSON.parse(matches[1]);
      console.log('State keys:', Object.keys(state));
    } else {
      console.log('__INITIAL_STATE__ not found.');
    }

    // Let's write the HTML to a file to inspect it
    const fs = require('fs');
    fs.writeFileSync('notion_page.html', html, 'utf8');
    console.log('notion_page.html saved.');
  } catch (err) {
    console.error(err);
  }
}

test();
