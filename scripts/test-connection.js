#!/usr/bin/env node
/**
 * Test script to verify Scriberr and Notion connections
 * Run: npm test (or node scripts/test-connection.js)
 */

require('dotenv').config();

const ScriberrClient = require('../src/scriberr');
const NotionClient = require('../src/notion');

async function main() {
  console.log('═══════════════════════════════════════════════════════════');
  console.log('  Voice-to-Notion Connection Test');
  console.log('═══════════════════════════════════════════════════════════\n');

  const results = { scriberr: false, notion: false };

  // Test Scriberr
  console.log('1. Testing Scriberr connection...');
  if (!process.env.SCRIBERR_API_URL || !process.env.SCRIBERR_USERNAME || !process.env.SCRIBERR_PASSWORD) {
    console.log('   SCRIBERR_API_URL, SCRIBERR_USERNAME, or SCRIBERR_PASSWORD not set');
  } else {
    try {
      const scriberr = new ScriberrClient(
        process.env.SCRIBERR_API_URL,
        process.env.SCRIBERR_USERNAME,
        process.env.SCRIBERR_PASSWORD
      );
      const healthy = await scriberr.healthCheck();
      if (healthy) {
        console.log('   Scriberr is reachable');

        // Authenticate
        await scriberr.init();
        console.log('   Auth OK');

        // Try to get jobs
        const jobs = await scriberr.getJobs();
        console.log(`   API working - found ${jobs?.length || 0} job(s)`);
        results.scriberr = true;
      } else {
        console.log('   Scriberr health check failed');
      }
    } catch (error) {
      console.log(`   Scriberr error: ${error.message}`);
    }
  }

  console.log('');

  // Test Notion
  console.log('2. Testing Notion connection...');
  if (!process.env.NOTION_API_KEY || !process.env.NOTION_DATABASE_ID) {
    console.log('   NOTION_API_KEY or NOTION_DATABASE_ID not set');
  } else {
    try {
      const notion = new NotionClient(
        process.env.NOTION_API_KEY,
        process.env.NOTION_DATABASE_ID
      );
      const connected = await notion.testConnection();
      if (connected) {
        console.log('   Notion API connected');
        console.log('   Database accessible');
        results.notion = true;
      } else {
        console.log('   Notion connection failed');
        console.log('   -> Check that your integration is shared with the database');
      }
    } catch (error) {
      console.log(`   Notion error: ${error.message}`);
      if (error.response?.data) {
        console.log(`   -> ${JSON.stringify(error.response.data)}`);
      }
    }
  }

  console.log('\n═══════════════════════════════════════════════════════════');
  console.log('  Results');
  console.log('═══════════════════════════════════════════════════════════');
  console.log(`  Scriberr: ${results.scriberr ? 'OK' : 'FAILED'}`);
  console.log(`  Notion:   ${results.notion ? 'OK' : 'FAILED'}`);
  console.log('═══════════════════════════════════════════════════════════\n');

  if (results.scriberr && results.notion) {
    console.log('All connections working! Start with: docker compose up -d\n');
    process.exit(0);
  } else {
    console.log('Fix the issues above before starting the worker.\n');
    process.exit(1);
  }
}

main().catch(console.error);
