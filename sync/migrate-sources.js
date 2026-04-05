#!/usr/bin/env node

const fs = require("fs");
const path = require("path");

const SOURCES_JSON = path.join(__dirname, "parsed-sources.json");
const DATA_JS_PATH = path.join(__dirname, "..", "data.js");

// Read parsed sources
const parsed = JSON.parse(fs.readFileSync(SOURCES_JSON, "utf-8"));

// Read data.js
const dataContent = fs.readFileSync(DATA_JS_PATH, "utf-8");
const match = dataContent.match(/const\s+SITE_DATA\s*=\s*(\{[\s\S]*\});?\s*$/);
if (!match) {
  console.error("Could not parse data.js");
  process.exit(1);
}
const siteData = eval(`(${match[1]})`);

// Build lookup: youtube_id → sources (converted from {name,url} to {text,url})
const sourcesMap = {};
for (const entry of parsed) {
  if (entry.sources.length > 0) {
    sourcesMap[entry.youtube_id] = entry.sources.map((s) => ({
      text: s.name,
      url: s.url,
    }));
  }
}

// Merge
let updated = 0;
let skipped = 0;
for (const video of siteData.videos) {
  const newSources = sourcesMap[video.youtube_id];
  if (newSources) {
    const had = video.sources?.length || 0;
    video.sources = newSources;
    console.log(`✅ ${video.title.substring(0, 60)}...`);
    console.log(`   ${had} → ${newSources.length} sources`);
    updated++;
  } else {
    console.log(`⚠️  ${video.title.substring(0, 60)}... (no sources in parsed data)`);
    skipped++;
  }
}

// Write back data.js preserving the header
const headerMatch = dataContent.match(/^([\s\S]*?)const\s+SITE_DATA\s*=/);
const header = headerMatch ? headerMatch[1] : "";
const json = JSON.stringify(siteData, null, 2);
const output = `${header}const SITE_DATA = ${json};\n`;

fs.writeFileSync(DATA_JS_PATH, output, "utf-8");

console.log(`\n${"=".repeat(60)}`);
console.log(`Updated: ${updated} videos with sources`);
console.log(`Skipped: ${skipped} videos (no sources found)`);
console.log(`Written to: ${DATA_JS_PATH}`);
