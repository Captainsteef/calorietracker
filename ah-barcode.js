// Proxy for Albert Heijn mobile API barcode lookup.
// Runs server-side so CORS is not an issue.
// Token is cached in module scope (persists across warm invocations).

let cachedToken = null;
let tokenExpiry = 0;

async function getAHToken() {
  if (cachedToken && Date.now() < tokenExpiry) {
    return cachedToken;
  }
  const res = await fetch('https://api.ah.nl/mobile-auth/v1/auth/token/anonymous', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'User-Agent': 'Appie/8.22.3'
    },
    body: JSON.stringify({ clientId: 'appie' })
  });
  if (!res.ok) throw new Error('AH auth failed: ' + res.status);
  const data = await res.json();
  cachedToken = data.access_token;
  // Expire 5 minutes before actual expiry to be safe
  tokenExpiry = Date.now() + ((data.expires_in || 7200) - 300) * 1000;
  return cachedToken;
}

// Normalise AH nutritional info array into flat macros object (per 100g)
function parseNutrition(product) {
  const result = { calories: 0, protein: 0, carbs: 0, fat: 0, fiber: 0 };

  // AH returns nutritionalInformations as an array of { type, value, unit }
  const items = product.nutritionalInformations || product.nutritionFacts || [];
  if (!Array.isArray(items)) return result;

  for (const item of items) {
    const type = (item.type || item.key || '').toUpperCase();
    const val  = parseFloat((item.value || '0').toString().replace(',', '.')) || 0;

    if (type.includes('ENERGY') && (type.includes('KCAL') || item.unit === 'kcal')) {
      result.calories = val;
    } else if (type === 'ENERGY_KJ' || (type.includes('ENERGY') && item.unit === 'kJ')) {
      // Fallback: only use kJ if no kcal found yet
      if (!result.calories) result.calories = Math.round(val / 4.184);
    } else if (type.includes('PROTEIN') || type === 'EIWITTEN') {
      result.protein = val;
    } else if (type.includes('CARBOHYDRATE') || type === 'KOOLHYDRATEN') {
      result.carbs = val;
    } else if (type === 'FAT' || type === 'TOTAL_FAT' || type === 'VETTEN' || type === 'VET') {
      result.fat = val;
    } else if (type.includes('FIBER') || type.includes('FIBRE') || type === 'VEZELS' || type === 'VOEDINGSVEZELS') {
      result.fiber = val;
    }
  }

  return result;
}

exports.handler = async function(event) {
  if (event.httpMethod !== 'GET') {
    return { statusCode: 405, body: 'Method not allowed' };
  }

  const barcode = (event.queryStringParameters || {}).barcode;
  if (!barcode || !/^\d{8,14}$/.test(barcode)) {
    return {
      statusCode: 400,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Invalid barcode' })
    };
  }

  let token;
  try {
    token = await getAHToken();
  } catch (err) {
    return {
      statusCode: 502,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'AH auth error: ' + err.message })
    };
  }

  const ahHeaders = {
    'Authorization': 'Bearer ' + token,
    'User-Agent': 'Appie/8.22.3',
    'Content-Type': 'application/json'
  };

  try {
    // Primary: GTIN/barcode lookup
    const gtinRes = await fetch(
      'https://api.ah.nl/mobile-services/product/search/v1/gtin/' + barcode,
      { headers: ahHeaders }
    );

    let product = null;

    if (gtinRes.ok) {
      const gtinData = await gtinRes.json();
      // The GTIN endpoint returns the product directly or nested under card.products
      product = gtinData?.card?.products?.[0]
        || gtinData?.products?.[0]
        || (gtinData?.title ? gtinData : null);
    }

    // Fallback: search by barcode as query string
    if (!product) {
      const searchRes = await fetch(
        'https://api.ah.nl/mobile-services/product/search/v2?query=' + barcode + '&sortOn=RELEVANCE&size=1',
        { headers: ahHeaders }
      );
      if (searchRes.ok) {
        const searchData = await searchRes.json();
        product = searchData?.products?.[0] || null;
      }
    }

    if (!product) {
      return {
        statusCode: 404,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: 'Product not found' })
      };
    }

    const macros   = parseNutrition(product);
    const name     = product.title || product.description || 'Onbekend product';
    const brand    = product.brand?.name || product.brandName || null;
    const fullName = brand && !name.toLowerCase().startsWith(brand.toLowerCase())
      ? brand + ' ' + name
      : name;

    // Try to get serving size from product details
    const servingSize = product.salesUnitSize || product.unitSize || null;

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'max-age=86400' },
      body: JSON.stringify({
        name: fullName.slice(0, 80),
        servingSize,
        calories: macros.calories,
        protein:  macros.protein,
        carbs:    macros.carbs,
        fat:      macros.fat,
        fiber:    macros.fiber
      })
    };

  } catch (err) {
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: err.message })
    };
  }
};
