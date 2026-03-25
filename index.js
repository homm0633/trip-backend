const express = require('express');
const fetch = require('node-fetch'); // node-fetch v2

const app = express();
const PORT = process.env.PORT || 3000;

// 🔑 在這裡填你的 SerpApi 金鑰
const SERPAPI_KEY = '5df2e19b0bdc181d569a9e23c8a11b4661c41705aa2319b49f689f2e09491ac0';

// （可選）仍保留 OpenTripMap geocode，用來把目的地名字標準化
const OTM_API_KEY = '5ae2e3f221c38a28845f05b6d06fa9a378207ab7512f2d98c57b65e8';

// 用地名查座標（OpenTripMap），只是為了拿到較標準的城市名稱
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

// 從 SerpApi 的 Google Maps 拿景點
async function fetchPlacesFromSerpApi(destination, limit = 20) {
  const params = new URLSearchParams({
    engine: 'google_maps',
    type: 'search',
    q: `things to do in ${destination}`, // 可以改成 attractions, sightseeing 等
    api_key: SERPAPI_KEY
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

  // 轉成 buildItineraryFromPlaces 會用到的格式
  const mapped = results
    .filter(p => p.title && p.gps_coordinates)
    .slice(0, limit)
    .map(p => ({
      name: p.title,
      kinds: p.type || '', // e.g. "Tourist attraction"
      point: {
        lat: p.gps_coordinates.latitude,
        lon: p.gps_coordinates.longitude
      },
      rate: p.rating || 0
    }));

  console.log('[SerpApi] mapped count =', mapped.length);
  return mapped;
}

// 從景點生成簡單行程
function buildItineraryFromPlaces(destinationName, places, days = 3) {
  const sorted = [...places].sort((a, b) => {
    const ra = a.rate || 0;
    const rb = b.rate || 0;
    return rb - ra;
  });

  const perDay = 5;
  const maxPlaces = perDay * days;
  const top = sorted.slice(0, maxPlaces);

  const dayPlans = [];

  for (let day = 1; day <= days; day++) {
    const start = (day - 1) * perDay;
    const chunk = top.slice(start, start + perDay);
    if (chunk.length === 0) break;

    const title = makeDayTitle(day, destinationName);
    const placesSimplified = chunk.map(p => ({
      name: p.name,
      kinds: p.kinds || '',
      lat: p.point.lat,
      lon: p.point.lon
    }));

    dayPlans.push({
      day,
      title,
      places: placesSimplified
    });
  }

  return {
    destination: destinationName,
    days: dayPlans
  };
}

function makeDayTitle(day, destination) {
  switch (day) {
    case 1: return `${destination} 市中心探索`;
    case 2: return `${destination} 文化與公園`;
    case 3: return `${destination} 周邊景點`;
    default: return `${destination} Day ${day}`;
  }
}

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

    // 1. geocode
    let displayName = destination;
    try {
      const geo = await geocodeDestination(destination);
      displayName = geo.name || destination;
    } catch (e) {
      console.log('[geocodeDestination] failed, fallback to raw destination');
    }

    // 2. SerpApi 拿地點
    const places = await fetchPlacesFromSerpApi(displayName, limit * 2);
    console.log('[SerpApi] results count =', places.length);

    // 3. 依 category 過濾
    const filtered = filterPlacesByCategory(places, category).slice(0, limit);

    // 4. 回傳簡化結果
    const result = filtered.map(p => ({
      id: p.place_id || p.placeId || p.google_id || p.id,
      name: p.name,
      address: p.formatted_address || p.address,
      rating: p.rating,
      latitude: p.location?.lat,
      longitude: p.location?.lng
    }));

    return res.json(result);
  } catch (err) {
    console.error('[/api/places] ERROR =', err);
    return res.status(500).json({ error: 'Failed to fetch places' });
  }
});

function filterPlacesByCategory(places, category) {
  if (!category || category === 'all') return places;

  const lower = category.toLowerCase();

  return places.filter(p => {
    const labels =
      (p.types || p.category_labels || p.categories || [])
        .join(' ')
        .toLowerCase();

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
               labels.includes('point_of_interest');
      case 'hotel':
        return labels.includes('hotel') || labels.includes('lodging');
      case 'other':
      default:
        return true;
    }
  });
}



// 啟動 server
app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
