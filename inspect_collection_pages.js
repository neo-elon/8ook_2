async function inspect() {
  const url = 'https://www.notion.so/api/v3/queryCollection';
  const body = {
    collection: { id: '821b0dd8-3da3-4f96-ad4d-223e75e5b59f' },
    collectionView: { id: 'b032a2b1-53be-46c9-a055-118bd1624729' },
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
    if (!recordMap) {
      console.log('No recordMap returned', data);
      return;
    }

    const collection = recordMap.collection?.['821b0dd8-3da3-4f96-ad4d-223e75e5b59f']?.value?.value;
    console.log('Collection schema:');
    for (const [key, val] of Object.entries(collection?.schema || {})) {
      console.log(` - ${key}: name="${val.name}", type="${val.type}"`);
    }

    console.log('\n--- Pages ---');
    const pages = Object.values(recordMap.block || {})
      .map(b => b.value?.value || b.value)
      .filter(val => val && val.type === 'page');

    console.log('Total pages in query:', pages.length);
    pages.forEach((p, idx) => {
      const title = p.properties?.title?.[0]?.[0] || 'Untitled';
      console.log(`\n[${idx+1}] Title: ${title}`);
      for (const [key, val] of Object.entries(p.properties || {})) {
        if (key === 'title') continue;
        const schemaName = collection?.schema?.[key]?.name || key;
        let cleanVal = '';
        if (val && Array.isArray(val)) {
          cleanVal = val.map(segment => segment[0]).join('').trim();
        }
        console.log(`  - ${schemaName} (${key}): ${cleanVal}`);
      }
      if (p.format?.page_cover) {
        console.log(`  - Cover: ${p.format.page_cover}`);
      }
    });

  } catch (err) {
    console.error(err);
  }
}

inspect();
