const fs = require("fs");
const path = require("path");
const https = require("https");

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

function fetchUrl(url, redirectsLeft = 5) {
  return new Promise((resolve, reject) => {
    https
      .get(url, (res) => {
        if (
          res.statusCode >= 300 &&
          res.statusCode < 400 &&
          res.headers.location &&
          redirectsLeft > 0
        ) {
          const next = res.headers.location.startsWith("http")
            ? res.headers.location
            : new URL(res.headers.location, url).toString();
          res.resume();
          return resolve(fetchUrl(next, redirectsLeft - 1));
        }

        if (res.statusCode >= 400) {
          res.resume();
          return reject(new Error(`HTTP ${res.statusCode}`));
        }

        let data = "";
        res.setEncoding("utf8");
        res.on("data", (c) => (data += c));
        res.on("end", () => resolve(data));
      })
      .on("error", reject);
  });
}

function first(arrOrVal) {
  if (Array.isArray(arrOrVal)) return arrOrVal[0] || "";
  return arrOrVal || "";
}

function toNumber(v) {
  if (v === null || v === undefined) return null;
  const n = Number(String(v).replace(",", "."));
  return Number.isFinite(n) ? n : null;
}

function slugify(s) {
  return String(s || "")
    .toLowerCase()
    .trim()
    .replace(/\s+/g, "_")
    .replace(/[^a-z0-9_]+/g, "");
}

function pickBanner(p) {
  if (Array.isArray(p?.images) && p.images.length) return p.images[0];
  if (p?.image) return p.image;
  if (p?.imageURL) return p.imageURL;
  if (p?.imageUrl) return p.imageUrl;
  return "";
}

// Probeer items te vinden, ongeacht top-level structuur
function extractItems(json) {
  if (Array.isArray(json)) return json;

  if (Array.isArray(json?.products)) return json.products;
  if (Array.isArray(json?.items)) return json.items;
  if (Array.isArray(json?.data)) return json.data;

  if (json?.productFeed) {
    if (Array.isArray(json.productFeed)) return json.productFeed;
    if (Array.isArray(json.productFeed.products)) return json.productFeed.products;
    if (Array.isArray(json.productFeed.items)) return json.productFeed.items;
  }

  return [];
}

(async () => {
  const url = process.env.TT_FEED_URL;
  if (!url) {
    console.error("Missing TT_FEED_URL secret");
    process.exit(1);
  }

  console.log("Downloading Sunweb JSON feed...");
  const raw = await fetchUrl(url);

  let json;
  try {
    json = JSON.parse(raw);
  } catch (e) {
    console.error("Not valid JSON. First 200 chars:");
    console.error(raw.slice(0, 200));
    process.exit(1);
  }

  const items = extractItems(json);
  if (!Array.isArray(items) || items.length === 0) {
    console.error("No items found. Top-level keys:", Object.keys(json || {}));
    process.exit(1);
  }

  console.log("Items:", items.length);

  // Land caps (pas aan als je wil)
  const COUNTRY_PRICE_CAPS = {
    Spanje: 600,
    Griekenland: 650,
    Turkije: 700,
    Portugal: 650,
    "Italië": 650,
    Egypte: 800,
  };
  const DEFAULT_CAP = 700;

  // Maak thin data
  const thin = items
    .map((p) => {
      const props = p.properties || {};

      const id = String(p.ID || p.id || p.productID || p.productId || "").trim();
      const title = String(p.name || p.title || p.productName || "").trim();

      // prijs kan op meerdere plekken zitten
      const price =
        toNumber(p?.price?.amount) ??
        toNumber(p?.price) ??
        toNumber(p?.amount) ??
        toNumber(p?.currentPrice) ??
        toNumber(p?.salePrice);

      const currency = String(p?.price?.currency || p.currency || "EUR");

      const link = String(p.URL || p.url || p.deeplink || p.productUrl || p.link || "").trim();
      const banner = pickBanner(p);

      const country = String(first(props.country) || p.country || "").trim();
      const departure = String(first(props.iataDeparture) || props.iataDeparture || p.departure || "").trim();
      const departureDate = String(first(props.departureDate) || props.departureDate || p.departureDate || "").trim();
      const duration = toNumber(first(props.duration) || props.duration || p.duration);

      // Extra velden, als ze bestaan bij Sunweb
      const stars = String(first(props.stars) || p.stars || "").trim();
      const province = String(first(props.province) || "").trim();
      const region = String(first(props.region) || "").trim();
      const serviceType = String(first(props.serviceType) || "").trim();

      return {
        id,
        title,
        price,
        currency,
        country,
        departure,
        departureDate,
        duration,
        stars,
        province,
        region,
        serviceType,
        url: link,
        banner,
      };
    })
    .filter((x) => x.id && x.url);

  thin.sort((a, b) => (a.price ?? 99999999) - (b.price ?? 99999999));

  const outBase = path.join(process.cwd(), "public", "sunweb");
  const outCountryDir = path.join(outBase, "country");
  ensureDir(outBase);
  ensureDir(outCountryDir);

  fs.writeFileSync(path.join(outBase, "all.min.json"), JSON.stringify(thin));

  const byCountry = new Map();
  for (const p of thin) {
    const c = p.country || "Onbekend";
    if (!byCountry.has(c)) byCountry.set(c, []);
    byCountry.get(c).push(p);
  }

  const countryIndex = {
    last_updated: new Date().toISOString(),
    caps: { ...COUNTRY_PRICE_CAPS, __default: DEFAULT_CAP },
    countries: {},
    files: {
      all_min: "sunweb/all.min.json",
      country_index: "sunweb/country/index.json",
    },
  };

  for (const [countryName, list] of byCountry.entries()) {
    const cap = COUNTRY_PRICE_CAPS[countryName] ?? DEFAULT_CAP;

    const filtered = list
      .filter((x) => x.price !== null && x.price <= cap)
      .sort((a, b) => (a.price ?? 99999999) - (b.price ?? 99999999));

    const fileName = `${slugify(countryName)}_under_${cap}.json`;
    fs.writeFileSync(path.join(outCountryDir, fileName), JSON.stringify(filtered));

    countryIndex.countries[countryName] = {
      cap,
      total: list.length,
      under_cap: filtered.length,
      file: `sunweb/country/${fileName}`,
    };
  }

  fs.writeFileSync(path.join(outCountryDir, "index.json"), JSON.stringify(countryIndex, null, 2));

  console.log("Done. Wrote public/sunweb/*.json");
})();
