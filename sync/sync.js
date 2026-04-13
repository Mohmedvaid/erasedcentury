#!/usr/bin/env node

// ==========================================
// ERASED CENTURY — YouTube Data Sync
// ==========================================
// Pulls latest channel stats + videos from YouTube API
// and updates data.js automatically.
//
// Usage:
//   1. Copy .env.example to .env and fill in your keys
//   2. npm install dotenv
//   3. node sync.js
//
// What it does:
//   - Fetches channel stats (subs, views, video count)
//   - Fetches latest N videos with titles, descriptions, dates, view counts
//   - Preserves your manually-added sources for each video
//   - Preserves about section, recaptcha key, beehiiv link
//   - Writes updated data.js
// ==========================================

const https = require("https");
const fs = require("fs");
const path = require("path");

// Load .env
require("dotenv").config({ path: path.join(__dirname, ".env") });

const API_KEY = process.env.YOUTUBE_API_KEY;
const CHANNEL_ID = process.env.YOUTUBE_CHANNEL_ID;
const MAX_VIDEOS = parseInt(process.env.MAX_VIDEOS || "20", 10);

// Path to data.js (one level up from /sync folder, or adjust as needed)
const DATA_JS_PATH =
  process.env.DATA_JS_PATH || path.join(__dirname, "..", "data.js");

if (!API_KEY || API_KEY === "your_api_key_here") {
  console.error("❌ Missing YOUTUBE_API_KEY in .env");
  process.exit(1);
}
if (!CHANNEL_ID || CHANNEL_ID === "your_channel_id_here") {
  console.error("❌ Missing YOUTUBE_CHANNEL_ID in .env");
  process.exit(1);
}

// ---- HTTP helper ----
function fetchJSON(url) {
  return new Promise((resolve, reject) => {
    https
      .get(url, (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => {
          try {
            resolve(JSON.parse(data));
          } catch (e) {
            reject(new Error(`JSON parse error: ${e.message}`));
          }
        });
      })
      .on("error", reject);
  });
}

// ---- Format numbers ----
function formatCount(n) {
  const num = parseInt(n, 10);
  if (num >= 1_000_000)
    return (num / 1_000_000).toFixed(1).replace(/\.0$/, "") + "M+";
  if (num >= 1_000) return (num / 1_000).toFixed(1).replace(/\.0$/, "") + "K";
  return num.toLocaleString();
}

function formatDate(isoDate) {
  const d = new Date(isoDate);
  return d.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric"
  });
}

function slugify(title) {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .substring(0, 60);
}

function formatDuration(iso) {
  // PT15M46S → 15:46, PT1H2M3S → 1:02:03
  const match = iso.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
  if (!match) return "0:00";
  const h = parseInt(match[1] || "0", 10);
  const m = parseInt(match[2] || "0", 10);
  const s = parseInt(match[3] || "0", 10);
  if (h > 0)
    return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  return `${m}:${String(s).padStart(2, "0")}`;
}

// ---- Load existing data.js ----
function loadExistingData() {
  try {
    if (!fs.existsSync(DATA_JS_PATH)) return null;
    const content = fs.readFileSync(DATA_JS_PATH, "utf-8");
    // Extract the JSON object from "const SITE_DATA = {...};"
    const match = content.match(/const\s+SITE_DATA\s*=\s*(\{[\s\S]*\});?\s*$/);
    if (!match) return null;
    // Use eval in a controlled way (it's our own file)
    const data = eval(`(${match[1]})`);
    return data;
  } catch (e) {
    console.warn(
      "⚠️  Could not parse existing data.js, will create fresh:",
      e.message
    );
    return null;
  }
}

// ---- YouTube API calls ----
async function fetchChannelStats() {
  const url = `https://www.googleapis.com/youtube/v3/channels?part=statistics,snippet&id=${CHANNEL_ID}&key=${API_KEY}`;
  const data = await fetchJSON(url);

  if (!data.items || !data.items.length) {
    throw new Error("Channel not found. Check your CHANNEL_ID.");
  }

  const stats = data.items[0].statistics;
  const snippet = data.items[0].snippet;

  return {
    name: snippet.title,
    subscribers: formatCount(stats.subscriberCount),
    documentaries: parseInt(stats.videoCount, 10),
    total_views: formatCount(stats.viewCount)
  };
}

async function fetchLatestVideos() {
  // Step 1: Get video IDs from uploads playlist (search endpoint has quota issues)
  const channelUrl = `https://www.googleapis.com/youtube/v3/channels?part=contentDetails&id=${CHANNEL_ID}&key=${API_KEY}`;
  const channelData = await fetchJSON(channelUrl);
  const uploadsPlaylistId =
    channelData.items[0].contentDetails.relatedPlaylists.uploads;

  // Step 2: Get latest video IDs from uploads playlist
  const playlistUrl = `https://www.googleapis.com/youtube/v3/playlistItems?part=contentDetails&playlistId=${uploadsPlaylistId}&maxResults=${MAX_VIDEOS}&key=${API_KEY}`;
  const playlistData = await fetchJSON(playlistUrl);
  const videoIds = playlistData.items.map(
    (item) => item.contentDetails.videoId
  );

  if (!videoIds.length) {
    console.warn("⚠️  No videos found in uploads playlist.");
    return [];
  }

  // Step 3: Get full details for each video
  const videosUrl = `https://www.googleapis.com/youtube/v3/videos?part=snippet,statistics,contentDetails&id=${videoIds.join(",")}&key=${API_KEY}`;
  const videosData = await fetchJSON(videosUrl);

  return videosData.items.map((item, index) => ({
    id: index + 1,
    youtube_id: item.id,
    slug: slugify(item.snippet.title),
    title: item.snippet.title,
    date: formatDate(item.snippet.publishedAt),
    duration: formatDuration(item.contentDetails.duration),
    views: formatCount(item.statistics.viewCount),
    description: item.snippet.description.split("\n")[0].substring(0, 300), // First line, max 300 chars
    thumbnail:
      item.snippet.thumbnails.maxres?.url ||
      item.snippet.thumbnails.standard?.url ||
      item.snippet.thumbnails.high?.url ||
      "",
    sources: [] // Will be merged from existing data
  }));
}

// ---- Merge sources and slugs from existing data ----
function mergeVideoSources(newVideos, existingVideos) {
  if (!existingVideos || !existingVideos.length) return newVideos;

  // Build lookups by youtube_id
  const sourcesMap = {};
  const slugMap = {};
  existingVideos.forEach((v) => {
    if (v.youtube_id && v.sources && v.sources.length) {
      sourcesMap[v.youtube_id] = v.sources;
    }
    if (v.youtube_id && v.slug) {
      slugMap[v.youtube_id] = v.slug;
    }
  });

  // Merge sources and preserve existing slugs
  return newVideos.map((v) => ({
    ...v,
    sources: sourcesMap[v.youtube_id] || v.sources || [],
    slug: slugMap[v.youtube_id] || slugify(v.title)
  }));
}

// ---- Write data.js ----
function writeDataJS(data) {
  const header = `// ==========================================
// ERASED CENTURY — SITE DATA
// ==========================================
// Auto-generated by sync.js on ${new Date().toISOString()}
// Edit sources manually, everything else syncs from YouTube.
// Push to GitHub and the site updates automatically.
// ==========================================

`;

  const json = JSON.stringify(data, null, 2);
  const content = `${header}const SITE_DATA = ${json};\n`;

  fs.writeFileSync(DATA_JS_PATH, content, "utf-8");
  console.log(`✅ Written to ${DATA_JS_PATH}`);
}

// ---- Main ----
async function main() {
  console.log("🔄 Syncing Erased Century data from YouTube...\n");

  // Load existing data to preserve manual fields
  const existing = loadExistingData();

  // Fetch from YouTube
  console.log("📡 Fetching channel stats...");
  const channelStats = await fetchChannelStats();
  console.log(
    `   Subs: ${channelStats.subscribers} | Videos: ${channelStats.documentaries} | Views: ${channelStats.total_views}`
  );

  console.log(`📡 Fetching latest ${MAX_VIDEOS} videos...`);
  let videos = await fetchLatestVideos();
  console.log(`   Found ${videos.length} videos`);

  // Merge sources from existing data
  if (existing && existing.videos) {
    videos = mergeVideoSources(videos, existing.videos);
    const withSources = videos.filter((v) => v.sources.length > 0).length;
    console.log(`   Preserved sources for ${withSources} videos`);
  }

  // Build final data object
  const data = {
    ...(existing || {}),
    recaptcha_site_key:
      existing?.recaptcha_site_key || "YOUR_RECAPTCHA_SITE_KEY",
    beehiiv_magic_link:
      existing?.beehiiv_magic_link || "YOUR_BEEHIIV_MAGIC_LINK",

    channel: {
      name: channelStats.name || existing?.channel?.name || "Erased Century",
      tagline: existing?.channel?.tagline || "Hidden History, Uncovered",
      description: existing?.channel?.description || "",
      youtube_url: `https://www.youtube.com/channel/${CHANNEL_ID}`,
      subscribe_url: `https://www.youtube.com/channel/${CHANNEL_ID}?sub_confirmation=1`,
      contact_email:
        existing?.channel?.contact_email || "contact@erasedcentury.com",
      subscribers: channelStats.subscribers,
      documentaries: channelStats.documentaries,
      total_views: channelStats.total_views,
      established: existing?.channel?.established || 2024,
      company: existing?.channel?.company || "Bold Core Media LLC"
    },

    about: existing?.about || {
      quote: "I wasn't looking for any of this.",
      paragraphs: [],
      signature: "— Erased Century / Bold Core Media LLC"
    },

    videos: videos
  };

  // Write
  writeDataJS(data);

  console.log(
    "\n🎉 Sync complete! Review data.js, add sources for new videos, then push to GitHub."
  );
}

main().catch((err) => {
  console.error("❌ Sync failed:", err.message);
  process.exit(1);
});
