async function test() {
  const url = 'https://www.notion.so/api/v3/queryCollection';
  const body = {
    collection: {
      id: '1938775c-a0cb-803c-84df-000b1ef322cb'
    },
    collectionView: {
      id: '1938775c-a0cb-8025-ad21-000cc24cf7e9'
    },
    loader: {
      type: 'reducer',
      reducers: {
        collection_group_results: {
          type: 'results',
          limit: 100
        }
      },
      searchQuery: '',
      userTimeZone: 'Asia/Seoul'
    }
  };

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json'
      },
      body: JSON.stringify(body)
    });
    console.log('Query Response Status:', res.status);
    const data = await res.json();
    console.log('Keys in query response:', Object.keys(data));
    
    const recordMap = data.recordMap;
    if (recordMap) {
      console.log('RecordMap keys:', Object.keys(recordMap));
    }
    
    // Let's print the collections schema to see what properties exist
    console.log('Collection keys in recordMap:', Object.keys(recordMap.collection || {}));
    const collectionId = Object.keys(recordMap.collection || {})[0];
    const collectionWrapper = recordMap.collection?.[collectionId];
    console.log('Collection wrapper:', JSON.stringify(collectionWrapper, null, 2));
    const collection = collectionWrapper?.value || collectionWrapper;
    if (collection) {
      console.log('Collection schema keys:', Object.keys(collection.schema || {}));
      console.log('Collection schema:', JSON.stringify(collection.schema, null, 2));
    }

    // Let's list the blocks of type "page"
    if (recordMap.block) {
      console.log('Found block count:', Object.keys(recordMap.block).length);
      const pages = Object.values(recordMap.block)
        .map(b => b.value)
        .filter(b => b && b.type === 'page');
      
      console.log('Pages count:', pages.length);
      
      // Let's print a few pages properties
      pages.forEach(p => {
        console.log(`Page: ${p.id}`);
        console.log('Properties:', JSON.stringify(p.properties, null, 2));
        console.log('Format (e.g. cover):', JSON.stringify(p.format, null, 2));
      });
    }
  } catch (err) {
    console.error('Error querying collection:', err);
  }
}

test();
