const fs = require('fs');

async function test() {
  const url = 'https://www.notion.so/api/v3/queryCollection';
  const body = {
    collection: { id: '1938775c-a0cb-8142-8b54-000b3a7d492d' },
    collectionView: { id: '1938775c-a0cb-81ba-b348-000c41b12ae0' },
    loader: {
      type: 'reducer',
      reducers: {
        collection_group_results: { type: 'results', limit: 5 }
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
    const collection = recordMap.collection?.['1938775c-a0cb-8142-8b54-000b3a7d492d']?.value?.value;
    console.log('Full Schema:');
    console.log(JSON.stringify(collection?.schema, null, 2));
  } catch (err) {
    console.error(err);
  }
}

test();
