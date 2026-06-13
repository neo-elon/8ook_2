async function test() {
  const targetPageId = '1938775c-a0cb-80b2-920f-d92bba68c539';
  const url = 'https://proxy.corsfix.com/?url=' + encodeURIComponent('https://www.notion.so/api/v3/loadPageChunk');
  
  const body = {
    pageId: targetPageId,
    limit: 100,
    cursor: { stack: [] },
    chunkNumber: 0,
    verticalColumns: false
  };

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'Origin': 'http://localhost:3000',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
      },
      body: JSON.stringify(body)
    });
    console.log('Proxy Response Status:', res.status);
    const text = await res.text();
    console.log('Raw text sample:', text.slice(0, 500));
  } catch (err) {
    console.error('Proxy request failed:', err);
  }
}

test();
