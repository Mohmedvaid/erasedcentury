#!/usr/bin/env node

const https = require("https");
const fs = require("fs");
const path = require("path");

require("dotenv").config({ path: path.join(__dirname, ".env") });

const API_KEY = process.env.YOUTUBE_API_KEY;
const DATA_JS_PATH = path.join(__dirname, "..", "data.js");

function fetchJSON(url) {
  return new Promise((resolve, reject) => {
    https
      .get(url, (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => {
          try { resolve(JSON.parse(data)); }
          catch (e) { reject(new Error(`JSON parse error: ${e.message}`)); }
        });
      })
      .on("error", reject);
  });
}

function lookAheadForUrl(lines, fromIdx, endPatterns, lateEndPatterns) {
  for (let j = fromIdx + 1; j < Math.min(fromIdx + 6, lines.length); j++) {
    const ahead = lines[j]?.trim();
    if (!ahead) continue;
    if (endPatterns.some((p) => p.test(ahead))) return null;
    if (lateEndPatterns.some((p) => p.test(ahead))) return null;
    if (/^[•·\-–—\*►▸]/.test(ahead)) return null;
    if (/^https?:\/\//.test(ahead)) return { url: ahead, endIdx: j };
  }
  return null;
}

function parseSources(description) {
  const sources = [];
  if (!description) return sources;

  const lines = description.split("\n").map((l) => l.trim());

  // Find the sources section — look for common headers (can appear anywhere)
  const headerPatterns = [
    /^📌\s*source/i,
    /^📌\s*credits/i,
    /^source\s*links?/i,
    /^sources?\s*[&:]/i,
    /^sources?\s*$/i,
  ];

  let startIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (headerPatterns.some((p) => p.test(lines[i]))) {
      startIdx = i + 1;
      break;
    }
  }

  if (startIdx === -1) return sources;

  // End markers — stop parsing when we hit these
  const endPatterns = [
    /^disclaimer/i,
    /^🔔/,
    /^#\s/,
    /^follow\s/i,
    /^📌\s*(?!source|credit)/i,
  ];

  // Also stop at subscribe/social blocks, but only if they appear AFTER the sources header
  const lateEndPatterns = [
    /^✅\s*subscribe/i,
    /^subscribe\s/i,
  ];

  for (let i = startIdx; i < lines.length; i++) {
    const line = lines[i];

    if (endPatterns.some((p) => p.test(line))) break;
    if (lateEndPatterns.some((p) => p.test(line))) break;
    if (!line) continue;

    // Bulleted source: • Name ... then URL within next few lines
    if (/^[•·\-–—\*►▸]/.test(line)) {
      const name = line.replace(/^[•·\-–—\*►▸]\s*/, "").trim();
      const found = lookAheadForUrl(lines, i, endPatterns, lateEndPatterns);
      if (found) {
        sources.push({ name, url: found.url });
        i = found.endIdx;
      } else {
        const urlMatch = name.match(/(https?:\/\/\S+)/);
        if (urlMatch) {
          const cleanName = name.replace(urlMatch[0], "").replace(/[:\-–—]\s*$/, "").trim();
          sources.push({ name: cleanName || name, url: urlMatch[1] });
        }
      }
    }
    // Non-bulleted source: plain text name line followed by a URL
    else if (!/^https?:\/\//.test(line)) {
      const found = lookAheadForUrl(lines, i, endPatterns, lateEndPatterns);
      if (found) {
        sources.push({ name: line, url: found.url });
        i = found.endIdx;
      }
    }
  }

  return sources;
}

async function main() {
  // Load video IDs from data.js
  const content = fs.readFileSync(DATA_JS_PATH, "utf-8");
  const match = content.match(/const\s+SITE_DATA\s*=\s*(\{[\s\S]*\});?\s*$/);
  const siteData = eval(`(${match[1]})`);
  const videoIds = siteData.videos.map((v) => v.youtube_id);

  console.log(`Fetching full descriptions for ${videoIds.length} videos...\n`);

  // YouTube API allows up to 50 IDs per request
  const url = `https://www.googleapis.com/youtube/v3/videos?part=snippet&id=${videoIds.join(",")}&key=${API_KEY}`;
  const data = await fetchJSON(url);

  if (data.error) {
    console.error("API error:", data.error.message);
    process.exit(1);
  }

  const results = [];
  let totalSources = 0;

  for (const item of data.items) {
    const ytId = item.id;
    const title = item.snippet.title;
    const desc = item.snippet.description;
    const sources = parseSources(desc);

    results.push({ youtube_id: ytId, title, sources });
    totalSources += sources.length;

    const status = sources.length > 0 ? `✅ ${sources.length} sources` : "⚠️  no sources found";
    console.log(`${title.substring(0, 70)}`);
    console.log(`   ${status}`);
    sources.forEach((s) => console.log(`   • ${s.name}`));
    console.log();
  }

  // Write output
  const outPath = path.join(__dirname, "parsed-sources.json");
  fs.writeFileSync(outPath, JSON.stringify(results, null, 2), "utf-8");

  console.log(`\n${"=".repeat(60)}`);
  console.log(`Total: ${totalSources} sources across ${results.filter((r) => r.sources.length > 0).length}/${results.length} videos`);
  console.log(`Output: ${outPath}`);
}

main().catch((err) => {
  console.error("Failed:", err.message);
  process.exit(1);
});
