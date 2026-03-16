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

function extractItems(json) {
  if (Array.isArray(json)) return json;
  if (Array.isArray(json?.products)) return json.products;
  if (Array.isArray(json?.items)) return json.items;
  if (Array.isArray(json?.data)) return json.data;
  if (Array.isArray(json?.productFeed?.products)) return json.productFeed.products;
  return [];
}

function first(val) {
  if (Array.isArray(val)) return val[0] || "";
  return val || "";
}

function toNumber(v) {
  if (v === null || v === undefined || v === "") return null;
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

function normalizeDate(value) {
  const s = String(value || "").trim();
  if (!s) return "";

  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    return s;
  }

  const mdy = s.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (mdy) {
    const a = Number(mdy[1]);
    const b = Number(mdy[2]);
    const y = mdy[3];

    // Sunweb is meestal MM/DD/YYYY
    if (a >= 1 && a <= 12 && b >= 1 && b <= 31) {
      return `${y}-${String(a).padStart(2, "0")}-${String(b).padStart(2, "0")}`;
    }

    // fallback voor DD/MM/YYYY
    if (a >= 1 && a <= 31 && b >= 1 && b <= 12) {
      return `${y}-${String(b).padStart(2, "0")}-${String(a).padStart(2, "0")}`;
    }
  }

  return "";
}

function getInnerSunwebUrl(outerUrl) {
  try {
    const outer = new URL(outerUrl);
    const embedded = outer.searchParams.get("r");
    if (!embedded) return null;
    return new URL(decodeURIComponent(embedded));
  } catch {
    return null;
  }
}

function enrichSunwebFromUrl(deal) {
  if (!deal?.url) return deal;

  const inner = getInnerSunwebUrl(deal.url);
  if (!inner) return deal;

  const p = inner.searchParams;

  if ((!deal.duration || deal.duration <= 0) && p.get("Duration[0]")) {
    deal.duration = toNumber(p.get("Duration[0]")) ?? deal.duration;
  }

  if (!deal.departureDate && p.get("DepartureDate[0]")) {
    deal.departureDate = normalizeDate(p.get("DepartureDate[0]"));
  }

  if (!deal.departure && p.get("DepartureAirport[0]")) {
    deal.departure = String(p.get("DepartureAirport[0]") || "").trim();
  }

  if (!deal.serviceType && p.get("Mealplan[0]")) {
    deal.serviceType = String(p.get("Mealplan[0]") || "").trim();
  }

  return deal;
}

async function fetchFeed(label, url) {
  if (!url) return [];
  console.log("Downloading:", label);
  const raw = await fetchUrl(url);

  let json;
  try {
    json = JSON.parse(raw);
  } catch (e) {
    console.error("JSON parse error in", label);
    return [];
  }

  const items = extractItems(json);
  console.log("Items in", label + ":", items.length);
  return items;
}

(async () => {
  const feeds = [
    { label: "general", url: process.env.TT_FEED_URL },
    { label: "turkije", url: process.env.TT_FEED_URL_TURKIJE },
    { label: "spanje", url: process.env.TT_FEED_URL_SPANJE },
    { label: "griekenland", url: process.env.TT_FEED_URL_GRIEKENLAND },
    { label: "egypte", url: process.env.TT_FEED_URL_EGYPTE },
  ];

  let rawItems = [];

  for (const f of feeds) {
    const items = await fetchFeed(f.label, f.url);
    rawItems = rawItems.concat(items);
  }

  console.log("Total raw items:", rawItems.length);

  const thinAll = rawItems
    .map((p) => {
      const props = p.properties || {};

      const id = String(p.ID || p.id || p.productID || p.productId || "").trim();
      const title = String(p.name || p.title || "").trim();

      const price =
        toNumber(p?.price?.amount) ??
        toNumber(p?.price) ??
        toNumber(p?.amount) ??
        toNumber(p?.currentPrice) ??
        toNumber(p?.salePrice);

      const currency = String(p?.price?.currency || p.currency || first(props.currency) || "EUR").trim();
      const link = String(p.URL || p.url || p.deeplink || p.link || "").trim();
      const banner = pickBanner(p);

      const country = String(first(props.country) || p.country || "").trim();
      const departure = String(first(props.iataDeparture) || "").trim();

      const departureDate =
        normalizeDate(first(props.departureDate)) ||
        normalizeDate(p.departureDate);

      const duration =
        toNumber(first(props.numberOfDays)) ??
        toNumber(first(props.duration)) ??
        toNumber(p.duration);

      const stars = String(first(props.stars) || p.stars || "").trim();
      const province = String(first(props.province) || p.province || "").trim();
      const region = String(first(props.region) || p.region || "").trim();
      const serviceType = String(first(props.serviceType) || p.serviceType || "").trim();

      let deal = {
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

      deal = enrichSunwebFromUrl(deal);

      return deal;
    })
    .filter((x) => x.url)
    .filter((x) => x.title)
    .filter((x) => x.price !== null && x.price > 0)
    .filter((x) => x.departureDate)
    .filter((x) => x.duration !== null && x.duration > 0);

  const seen = new Set();
  const thin = [];

  for (const item of thinAll) {
    const key = item.id ? "id:" + item.id : "url:" + item.url;
    if (!seen.has(key)) {
      seen.add(key);
      thin.push(item);
    }
  }

  console.log("After dedupe:", thin.length);

  thin.sort((a, b) => (a.price ?? 99999999) - (b.price ?? 99999999));

  const COUNTRY_PRICE_CAPS = {
    Spanje: 600,
    Griekenland: 650,
    Turkije: 700,
    Egypte: 800,
  };

  const DEFAULT_CAP = 700;

  const outBase = path.join(process.cwd(), "public", "sunweb");
  const outCountryDir = path.join(outBase, "country");

  ensureDir(outBase);
  ensureDir(outCountryDir);

  fs.writeFileSync(path.join(outBase, "all.min.json"), JSON.stringify(thin));

  const byCountry = {};

  thin.forEach((p) => {
    const c = p.country || "Onbekend";
    if (!byCountry[c]) byCountry[c] = [];
    byCountry[c].push(p);
  });

  const index = {
    last_updated: new Date().toISOString(),
    countries: {},
  };

  for (const country in byCountry) {
    const cap = COUNTRY_PRICE_CAPS[country] ?? DEFAULT_CAP;

    const filtered = byCountry[country]
      .filter((x) => x.price !== null && x.price <= cap)
      .sort((a, b) => (a.price ?? 99999999) - (b.price ?? 99999999));

    const fileName = `${slugify(country)}_under_${cap}.json`;

    fs.writeFileSync(
      path.join(outCountryDir, fileName),
      JSON.stringify(filtered)
    );

    index.countries[country] = {
      cap,
      total: byCountry[country].length,
      under_cap: filtered.length,
      file: `sunweb/country/${fileName}`,
    };
  }

  fs.writeFileSync(
    path.join(outCountryDir, "index.json"),
    JSON.stringify(index, null, 2)
  );

  console.log("Sunweb build completed.");
})();
