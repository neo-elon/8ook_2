async function inspect() {
  const url = 'https://www.notion.so/api/v3/queryCollection';
  const body = {
    collection: { id: '1938775c-a0cb-8142-8b54-000b3a7d492d' },
    collectionView: { id: '1938775c-a0cb-81ba-b348-000c41b12ae0' },
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
      console.log('No recordMap');
      return;
    }

    const pages = Object.values(recordMap.block || {})
      .map(b => b.value?.value || b.value)
      .filter(val => val && val.type === 'page');

    console.log(`Found ${pages.length} pages in 2025년 12월 완독책장`);

    pages.forEach(p => {
      console.log('\n--- Page ---');
      console.log('Title:', p.properties?.title?.[0]?.[0]);
      console.log('Properties:', JSON.stringify(p.properties, null, 2));
    });

  } catch (err) {
    console.error(err);
  }
}

inspect();

