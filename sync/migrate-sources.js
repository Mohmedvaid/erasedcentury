#!/usr/bin/env node

const fs = require("fs");
const path = require("path");

const SOURCES_JSON = path.join(__dirname, "parsed-sources.json");
const DATA_JS_PATH = path.join(__dirname, "..", "data.js");
const FORCE = process.argv.includes("--force") || process.argv.includes("-f");

function parseBoundaryDate(value) {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

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

const boundaryDate = parseBoundaryDate(siteData.source_sync_boundary_date);
if (boundaryDate) {
  console.log(`Source sync boundary date: ${boundaryDate.toISOString().slice(0, 10)}`);
}
console.log(`Migrate sources: preserving existing sources by default${FORCE ? ' (force mode enabled)' : ''}.`);

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
let latestUpdatedDate = boundaryDate || null;
for (const video of siteData.videos) {
  const newSources = sourcesMap[video.youtube_id];
  const had = video.sources?.length || 0;
  const videoDate = video.date ? parseBoundaryDate(video.date) : null;

  if (newSources) {
    if (boundaryDate && videoDate && videoDate <= boundaryDate && !FORCE) {
      console.log(`⏭️  ${video.title.substring(0, 60)}... (before boundary, skipped)`);
      skipped++;
      continue;
    }

    if (had > 0 && !FORCE) {
      console.log(`⏭️  ${video.title.substring(0, 60)}... (existing ${had} source${had === 1 ? '' : 's'} preserved)`);
      skipped++;
      continue;
    }

    video.sources = newSources;
    console.log(`✅ ${video.title.substring(0, 60)}...`);
    console.log(`   ${had} → ${newSources.length} sources`);
    updated++;

    if (videoDate && (!latestUpdatedDate || videoDate > latestUpdatedDate)) {
      latestUpdatedDate = videoDate;
    }
  } else {
    console.log(`⚠️  ${video.title.substring(0, 60)}... (no sources in parsed data)`);
    skipped++;
  }
}
if (latestUpdatedDate) {
  siteData.source_sync_boundary_date = latestUpdatedDate.toISOString().slice(0, 10);
  console.log(`Boundary advanced to: ${siteData.source_sync_boundary_date}`);
}
// Write back data.js preserving the header
const headerMatch = dataContent.match(/^([\s\S]*?)const\s+SITE_DATA\s*=/);
const header = headerMatch ? headerMatch[1] : "";
const json = JSON.stringify(siteData, null, 2);
const output = `${header}const SITE_DATA = ${json};\n`;

fs.writeFileSync(DATA_JS_PATH, output, "utf-8");

console.log(`\n${"=".repeat(60)}`);
console.log(`Updated: ${updated} videos with sources`);
console.log(`Skipped: ${skipped} videos (existing sources preserved or no parsed sources)`);
console.log(`Written to: ${DATA_JS_PATH}`);
