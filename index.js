const express = require('express');
const fetch = require('node-fetch'); // node-fetch v2

const app = express();
const PORT = process.env.PORT || 3000;

const SERPAPI_KEY = process.env.SERPAPI_KEY;
const OTM_API_KEY = process.env.OPENTRIPMAP_KEY;

console.log('[ENV] SERPAPI_KEY =', SERPAPI_KEY ? 'SET' : 'MISSING');
console.log('[ENV] OTM_API_KEY =', OTM_API_KEY ? 'SET' : 'MISSING');

// ---------- Geocode: OpenTripMap ----------

async function geocodeDestination(name) {
  console.log('typeof fetch inside geocode =', typeof fetch);
  console.log('[geocodeDestination] name =', name);
  const url = `https://api.opentripmap.com/0.1/en/places/geoname?name=${encodeURIComponent(
    name
  )}&apikey=${OTM_API_KEY}`;
  console.log('[geocodeDestination] url =', url);

  const res = await fetch(url);
  console.log('[geocodeDestination] status =', res.status);
  if (!res.ok) throw new Error('Geoname request failed');

  const data = await res.json();
  console.log('[geocodeDestination] response =', data);

  if (!data.lat || !data.lon) {
    throw new Error('Destination not found');
  }

  return { lat: data.lat, lon: data.lon, name: data.name || name };
}

// ---------- SerpApi: Google Maps ----------

async function fetchPlacesFromSerpApi(destination, limit = 20) {
  const params = new URLSearchParams({
    engine: 'google_maps',
    type: 'search',
    q: `things to do in ${destination}`,
    api_key: SERPAPI_KEY            // 這裡要是你 Playground 那條 key
  });

  const url = `https://serpapi.com/search.json?${params.toString()}`;
  console.log('[SerpApi] url =', url);

  const res = await fetch(url);
  console.log('[SerpApi] status =', res.status);
  if (!res.ok) {
    const text = await res.text();
    console.log('[SerpApi] error body =', text);
    throw new Error('SerpApi request failed');
  }

  const data = await res.json();
  const results = data.local_results || [];
  console.log('[SerpApi] results count =', results.length);

  // 這裡就直接轉成我們自己的格式
  const mapped = results
    .filter(p => p.title && p.gps_coordinates)
    .slice(0, limit)
    .map(p => ({
      name: p.title,
      // SerpApi 常見欄位：type / categories / category / place_id...
      kinds: [p.type, ...(p.categories || [])].filter(Boolean).join(', '),
      lat: p.gps_coordinates.latitude,
      lon: p.gps_coordinates.longitude,
      rate: p.rating || 0
    }));

  console.log('[SerpApi] mapped count =', mapped.length);
  return mapped;
}

// ---------- /api/places：給 App 用 ----------

// GET /api/places?destination=Fukuoka&category=cafe&limit=20
app.get('/api/places', async (req, res) => {
  try {
    const destination = (req.query.destination || '').trim();
    const category = (req.query.category || 'all').trim();
    const limit = parseInt(req.query.limit || '20', 10);

    if (!destination) {
      return res.status(400).json({ error: 'Missing destination' });
    }

    console.log('[/api/places] destination =', destination, 'category =', category, 'limit =', limit);

    // 1. geocode → 拿標準名稱
    let displayName = destination;
    try {
      const geo = await geocodeDestination(destination);
      displayName = geo.name || destination;
    } catch (e) {
      console.log('[geocodeDestination] failed, fallback to raw destination');
    }

    // 2. SerpApi 拿地點（已是簡化後格式）
    const places = await fetchPlacesFromSerpApi(displayName, limit * 2);

    // 3. 依 category 過濾（用 kinds 判斷）
    const filtered = filterPlacesByCategory(places, category).slice(0, limit);

    // 4. 回傳給 iOS 的結構
    const result = filtered.map((p, index) => ({
      id: `${index}-${p.name}`,     // 簡單產生一個 id 給前端
      name: p.name,
      address: null,               // SerpApi 簡化後沒保留 address，如要可在上面 map 時一起帶
      rating: p.rate,
      latitude: p.lat,
      longitude: p.lon
    }));

    return res.json(result);
  } catch (err) {
    console.error('[/api/places] ERROR =', err);
    return res.status(500).json({ error: 'Failed to fetch places' });
  }
});

// 用 kinds 做簡單分類
function filterPlacesByCategory(places, category) {
  if (!category || category === 'all') return places;

  const lower = category.toLowerCase();

  return places.filter(p => {
    const labels = (p.kinds || '').toLowerCase();

    switch (lower) {
      case 'cafe':
        return labels.includes('cafe') || labels.includes('coffee');
      case 'restaurant':
        return labels.includes('restaurant') || labels.includes('food') || labels.includes('dining');
      case 'shopping':
        return labels.includes('shopping') || labels.includes('store') || labels.includes('mall');
      case 'sightseeing':
        return labels.includes('tourist') ||
               labels.includes('attraction') ||
               labels.includes('landmark') ||
               labels.includes('point_of_interest') ||
               labels.includes('sightseeing');
      case 'hotel':
        return labels.includes('hotel') || labels.includes('lodging');
      case 'other':
      default:
        return true;
    }
  });
}

// ---------- 啟動 server ----------

app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});

