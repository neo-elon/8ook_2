const fs = require('fs');

async function test() {
  const url = 'https://www.notion.so/api/v3/queryCollection';
  const body = {
    collection: { id: '1938775c-a0cb-803c-84df-000b1ef322cb' },
    collectionView: { id: '1938775c-a0cb-8025-ad21-000cc24cf7e9' },
    loader: {
      type: 'reducer',
      reducers: {
        collection_group_results: { type: 'results', limit: 100 }
      },
      searchQuery: '',
      userTimeZone: 'Asia/Seoul'
    }
  };

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body)
    });
    const data = await res.json();
    const recordMap = data.recordMap;
    
    // Save recordMap to a json file to inspect it
    fs.writeFileSync('recordMap.json', JSON.stringify(recordMap, null, 2), 'utf8');
    console.log('recordMap.json saved.');

    const collection = Object.values(recordMap.collection || {})[0]?.value;
    console.log('Collection Title:', collection?.name?.[0]?.[0]);
    console.log('Schema properties:');
    for (const [key, prop] of Object.entries(collection?.schema || {})) {
      console.log(`- ${key}: name="${prop.name}", type="${prop.type}"`);
    }

    const blocks = Object.values(recordMap.block || {}).map(b => b.value).filter(Boolean);
    console.log('Total blocks:', blocks.length);
    const pages = blocks.filter(b => b.type === 'page');
    console.log('Pages:', pages.length);

    pages.forEach(p => {
      const title = p.properties?.title?.[0]?.[0] || 'Untitled';
      console.log(`Page Title: ${title}`);
      
      // Let's print each property key and value
      for (const [key, val] of Object.entries(p.properties || {})) {
        if (key === 'title') continue;
        const schemaName = collection?.schema?.[key]?.name || key;
        const textVal = val?.[0]?.[0] || '';
        console.log(`  ${schemaName} (${key}): ${JSON.stringify(val)} -> ${textVal}`);
      }

      // Check format
      if (p.format) {
        console.log('  Format:', JSON.stringify(p.format));
      }
    });

  } catch (err) {
    console.error(err);
  }
}

test();
