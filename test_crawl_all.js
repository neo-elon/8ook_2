const fs = require('fs');

const PROXY = 'https://proxy.corsfix.com/?url=';
const HEADERS = {
  'content-type': 'application/json',
  'Origin': 'http://localhost:3000',
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
};

async function postNotion(endpoint, body) {
  const url = PROXY + encodeURIComponent('https://www.notion.so/api/v3/' + endpoint);
  const res = await fetch(url, {
    method: 'POST',
    headers: HEADERS,
    body: JSON.stringify(body)
  });
  if (!res.ok) {
    throw new Error(`Notion API returned ${res.status}: ${await res.text()}`);
  }
  return res.json();
}

async function test() {
  const pageIdRaw = '1938775ca0cb80b2920fd92bba68c539';
  const pageId = pageIdRaw.replace(/(.{8})(.{4})(.{4})(.{4})(.{12})/, '$1-$2-$3-$4-$5');
  console.log('Target Page UUID:', pageId);

  try {
    console.log('1. Loading page chunk...');
    const pageData = await postNotion('loadPageChunk', {
      pageId: pageId,
      limit: 100,
      cursor: { stack: [] },
      chunkNumber: 0,
      verticalColumns: false
    });

    const recordMap = pageData.recordMap;
    if (!recordMap) {
      console.log('No recordMap in page load response');
      return;
    }

    const targetBlock = recordMap.block?.[pageId]?.value?.value;
    const nickname = targetBlock?.properties?.title?.[0]?.[0] || 'Unknown';
    console.log(`Nickname parsed from page title: "${nickname}"`);

    // Find all collections that represent monthly bookshelves
    const bookshelveCollections = [];
    
    // We map collection_id to its first view_id from collection_view blocks
    const colToView = {};
    for (const [id, block] of Object.entries(recordMap.block || {})) {
      const val = block.value?.value || block.value;
      if (val && (val.type === 'collection_view' || val.type === 'collection_view_page')) {
        const cid = val.collection_id;
        const vids = val.view_ids;
        if (cid && vids && vids.length > 0) {
          colToView[cid] = vids[0];
        }
      }
    }

    // Now identify collections that have names ending with '완독책장'
    for (const [id, col] of Object.entries(recordMap.collection || {})) {
      const val = col.value?.value || col.value;
      const name = val?.name?.[0]?.[0] || '';
      if (name.includes('완독책장')) {
        const viewId = colToView[id];
        if (viewId) {
          bookshelveCollections.push({ id, name, viewId });
        }
      }
    }

    console.log(`Found ${bookshelveCollections.length} bookshelf databases:`);
    bookshelveCollections.forEach(c => console.log(` - ${c.name} (ID: ${c.id}, View ID: ${c.viewId})`));

    // Query each collection one by one
    const allBooks = [];

    for (const shelf of bookshelveCollections) {
      console.log(`\nQuerying "${shelf.name}"...`);
      try {
        const colData = await postNotion('queryCollection', {
          collection: { id: shelf.id },
          collectionView: { id: shelf.viewId },
          loader: {
            type: 'reducer',
            reducers: {
              collection_group_results: { type: 'results', limit: 100 }
            },
            searchQuery: '',
            userTimeZone: 'Asia/Seoul'
          }
        });

        const shelfRecordMap = colData.recordMap;
        if (!shelfRecordMap || !shelfRecordMap.block) {
          console.log(`No blocks in "${shelf.name}" response`);
          continue;
        }

        const schema = shelfRecordMap.collection?.[shelf.id]?.value?.value?.schema || {};

        // Find the keys for:
        // - "나만의 한 문장" -> type='text', contains '한 문장' or ';c}l'
        // - "책 표지 이미지" -> type='file'
        // - "저자" -> contains '저자'
        // - "완독일" or "서평일" -> contains '완독' or '서평'
        // - "페이지수" -> contains '페이지'
        // - "서평 링크" -> contains '서평 링크' or '링크'
        let sentenceKey = null;
        let coverKey = null;
        let authorKey = null;
        let dateKey = null;
        let pagesKey = null;
        let linkKey = null;

        for (const [key, val] of Object.entries(schema)) {
          const name = val.name || '';
          if (name.includes('한 문장') || name.includes('한줄평')) sentenceKey = key;
          else if (name.includes('표지') || name.includes('이미지')) coverKey = key;
          else if (name.includes('저자')) authorKey = key;
          else if (name.includes('완독') || name.includes('서평일')) dateKey = key;
          else if (name.includes('페이지')) pagesKey = key;
          else if (name.includes('서평 링크') || name.includes('블로그') || name.includes('링크')) linkKey = key;
        }

        // Default fallbacks if not matched by name
        if (!sentenceKey) sentenceKey = ';c}l';
        if (!coverKey) coverKey = 'CUHb';
        if (!authorKey) authorKey = 'krIc';
        if (!dateKey) dateKey = 'Dtq~';
        if (!pagesKey) pagesKey = 'MCnP';
        if (!linkKey) linkKey = '\\JpV';

        const pages = Object.values(shelfRecordMap.block)
          .map(b => b.value?.value || b.value)
          .filter(val => val && val.type === 'page');

        let parsedCount = 0;
        pages.forEach(p => {
          // Check if this row is related to the target page UUID
          let isUserBook = false;

          // Check all properties for a relation pointing to target page UUID
          for (const [key, val] of Object.entries(p.properties || {})) {
            if (val && Array.isArray(val)) {
              val.forEach(seg => {
                if (seg[1] && Array.isArray(seg[1])) {
                  seg[1].forEach(op => {
                    if (op[0] === 'p' && op[1] === pageId) {
                      isUserBook = true;
                    }
                  });
                }
              });
            }
          }

          // Alternatively check the select nickname column if it matches
          const nicknameProp = p.properties?.oXKm || p.properties?.닉네임;
          if (nicknameProp) {
            const nickText = nicknameProp.map(s => s[0]).join('').trim();
            if (nickText === nickname) {
              isUserBook = true;
            }
          }

          if (isUserBook) {
            const title = p.properties?.title?.[0]?.[0] || 'Untitled';
            
            // Extract author
            let author = '';
            const authVal = p.properties?.[authorKey];
            if (authVal && Array.isArray(authVal)) author = authVal.map(s => s[0]).join('').trim();

            // Extract pages
            let pagesNum = 0;
            const pageVal = p.properties?.[pagesKey];
            if (pageVal && Array.isArray(pageVal)) pagesNum = parseInt(pageVal.map(s => s[0]).join('').trim()) || 0;

            // Extract date
            let date = '';
            const dateVal = p.properties?.[dateKey];
            if (dateVal && Array.isArray(dateVal)) {
              // Extract date object
              const dateObj = dateVal[0]?.[1]?.[0]?.[1];
              if (dateObj && dateObj.start_date) {
                date = dateObj.start_date;
              } else {
                date = dateVal.map(s => s[0]).join('').trim();
              }
            }

            // Extract sentence
            let sentence = '';
            const sentVal = p.properties?.[sentenceKey];
            if (sentVal && Array.isArray(sentVal)) sentence = sentVal.map(s => s[0]).join('').trim();

            // Extract cover image
            let cover = '';
            const covVal = p.properties?.[coverKey];
            if (covVal && Array.isArray(covVal)) {
              // File type values are typically structured like:
              // [["filename", [["e", "url"]]]] or similar
              const fileUrl = covVal[0]?.[1]?.[0]?.[1];
              if (fileUrl) {
                cover = fileUrl;
              } else {
                cover = covVal.map(s => s[0]).join('').trim();
              }
            }
            // Fallback cover if in page format
            if (!cover && p.format?.page_cover) {
              cover = p.format.page_cover;
            }

            // Extract link
            let link = '';
            const lnkVal = p.properties?.[linkKey];
            if (lnkVal && Array.isArray(lnkVal)) {
              const url = lnkVal[0]?.[1]?.[0]?.[1];
              if (url) link = url;
              else link = lnkVal.map(s => s[0]).join('').trim();
            }

            // Map keywords to an array
            const keywords = [];
            if (shelf.name) {
              // Extract year and month, e.g. "2025년 1월"
              const match = shelf.name.match(/\d+년\s*\d+월/);
              if (match) keywords.push(match[0]);
            }

            allBooks.push({
              title,
              author,
              pages: pagesNum,
              date,
              sentence,
              cover,
              link,
              keywords
            });
            parsedCount++;
          }
        });

        console.log(`Parsed ${parsedCount} books from "${shelf.name}"`);

      } catch (err) {
        console.error(`Error querying "${shelf.name}":`, err);
      }
    }

    console.log(`\n=== Total Parsed Books: ${allBooks.length} ===`);
    console.log(JSON.stringify(allBooks.slice(0, 5), null, 2));

  } catch (err) {
    console.error(err);
  }
}

test();
