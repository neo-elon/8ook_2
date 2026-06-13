const pageIdRaw = '1938775ca0cb80b2920fd92bba68c539';
const pageId = pageIdRaw.replace(/(.{8})(.{4})(.{4})(.{4})(.{12})/, '$1-$2-$3-$4-$5');
console.log('Formatted Page ID:', pageId);

async function inspect() {
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
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body)
    });
    const data = await res.json();
    const recordMap = data.recordMap;
    if (!recordMap) {
      console.log('No recordMap returned');
      return;
    }

    console.log('\n--- Blocks in page load ---');
    for (const [id, block] of Object.entries(recordMap.block || {})) {
      const val = block.value?.value || block.value;
      if (!val) continue;
      console.log(`Block ${id}: type=${val.type}, title=${val.properties?.title?.[0]?.[0] || ''}`);
      if (val.type === 'collection_view' || val.type === 'collection_view_page') {
        console.log(`  Collection ID: ${val.collection_id}`);
        console.log(`  View IDs:`, val.view_ids);
      }
    }

    console.log('\n--- Collections in page load ---');
    for (const [id, col] of Object.entries(recordMap.collection || {})) {
      const val = col.value?.value || col.value;
      console.log(`Collection ${id}: Name=${val?.name?.[0]?.[0] || 'Unnamed'}`);
    }

  } catch (err) {
    console.error(err);
  }
}

inspect();
