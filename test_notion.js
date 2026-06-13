async function test() {
  const pageIdRaw = '1938775ca0cb80b2920fd92bba68c539';
  // Format to UUID format: 8-4-4-4-12
  const pageId = pageIdRaw.replace(/(.{8})(.{4})(.{4})(.{4})(.{12})/, '$1-$2-$3-$4-$5');
  console.log('Formatted Page ID:', pageId);

  const url = 'https://www.notion.so/api/v3/loadPageChunk';
  const body = {
    pageId: pageId,
    limit: 100,
    cursor: { stack: [] },
    chunkNumber: 0,
    verticalColumns: false
  };

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json'
      },
      body: JSON.stringify(body)
    });
    console.log('Response Status:', res.status);
    const data = await res.json();
    console.log('Keys in response:', Object.keys(data));
    
    // Look at data.recordMap
    const recordMap = data.recordMap;
    if (!recordMap) {
      console.log('No recordMap in response:', data);
      return;
    }

    console.log('recordMap keys:', Object.keys(recordMap));
    
    // Check if there is a collection
    if (recordMap.collection) {
      console.log('Found collections:', Object.keys(recordMap.collection));
    }
    if (recordMap.collection_view) {
      console.log('Found collection views:', Object.keys(recordMap.collection_view));
    }
    // Check block keys and types
    if (recordMap.block) {
      console.log('Blocks count:', Object.keys(recordMap.block).length);
      const firstKey = Object.keys(recordMap.block)[0];
      console.log('First block raw structure:', JSON.stringify(recordMap.block[firstKey], null, 2));
      for (const [id, block] of Object.entries(recordMap.block)) {
        const value = block.value || block; // fallback if nested
        if (!value) continue;
        console.log(`Block ${id}: type=${value.type}, parent_type=${value.parent_type}`);
        if (value.type === 'collection_view_page' || value.type === 'collection_view') {
          console.log('Collection View block value:', JSON.stringify(value, null, 2));
        }
      }
    }
    if (recordMap.collection) {
      for (const [id, coll] of Object.entries(recordMap.collection)) {
        console.log(`Collection ${id}:`, JSON.stringify(coll.value?.name, null, 2));
      }
    }
  } catch (err) {
    console.error('Error fetching page chunk:', err);
  }
}

test();
